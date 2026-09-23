use moduleloom_analyzer::analyze_directory;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_end_to_end_module_graph_analysis() {
    let root = tempdir().expect("Create tempdir");
    let base = root.path();

    // Create a multi-package Python project structure
    // pkg_a/mod1.py <-> pkg_b/mod2.py (Circular import)
    // pkg_c/giant.py (Bloated module)
    let pkg_a = base.join("pkg_a");
    let pkg_b = base.join("pkg_b");
    let pkg_c = base.join("pkg_c");
    fs::create_dir_all(&pkg_a).unwrap();
    fs::create_dir_all(&pkg_b).unwrap();
    fs::create_dir_all(&pkg_c).unwrap();

    fs::write(
        pkg_a.join("mod1.py"),
        r#"import os
from pkg_b.mod2 import func2

def func1(x: int) -> int:
    return func2(x)
"#,
    )
    .unwrap();

    fs::write(
        pkg_b.join("mod2.py"),
        r#"from pkg_a.mod1 import func1

def func2(y):
    return y * 2
"#,
    )
    .unwrap();

    // Giant module with > 300 LOC
    let mut giant_content = String::new();
    giant_content.push_str("# Giant module test\n");
    for i in 0..320 {
        giant_content.push_str(&format!("def dummy_func_{}():\n    pass\n\n", i));
    }
    fs::write(pkg_c.join("giant.py"), giant_content).unwrap();

    // Run analyzer
    let result = analyze_directory(base).expect("analyze_directory should succeed");

    // 1. Verify module count
    assert_eq!(result.modules.len(), 3);

    // 2. Verify circular import detection
    assert_eq!(
        result.cycles.len(),
        1,
        "Must detect 1 circular import cycle"
    );
    let cycle = &result.cycles[0];
    assert!(cycle.modules.contains(&"pkg_a.mod1".to_string()));
    assert!(cycle.modules.contains(&"pkg_b.mod2".to_string()));

    // 3. Verify edges and circular flags
    assert_eq!(result.edges.len(), 2);
    assert!(result.edges.iter().all(|e| e.is_circular));

    let mod1 = result
        .modules
        .iter()
        .find(|m| m.id == "pkg_a.mod1")
        .unwrap();
    assert_eq!(mod1.efferent_coupling, 1);
    assert_eq!(mod1.afferent_coupling, 1);
    assert_eq!(mod1.unresolved_imports, vec!["os".to_string()]);

    // 4. Verify bloat detection
    let giant_mod = result
        .modules
        .iter()
        .find(|m| m.id == "pkg_c.giant")
        .expect("Find giant");
    assert!(
        giant_mod.is_oversized,
        "Giant module must be flagged as oversized"
    );
    assert!(giant_mod.loc > 300);

    // 5. Verify type check diagnostic (func2 has untyped argument y)
    let mod2 = result
        .modules
        .iter()
        .find(|m| m.id == "pkg_b.mod2")
        .expect("Find mod2");
    assert!(
        mod2.diagnostics
            .iter()
            .any(|d| d.rule.as_deref() == Some("ty-type-check")),
        "Should generate type check diagnostic for untyped argument y"
    );
}

#[test]
fn reports_dependency_manifest_mismatches() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::write(
        base.join("main.py"),
        "import requests\nimport certifi\nimport pytest\n",
    )
    .unwrap();
    fs::write(
        base.join("pyproject.toml"),
        "[project]\ndependencies = [\"httpx\", \"os\"]\n[dependency-groups]\ndev = [\"pytest\"]\n",
    )
    .unwrap();
    fs::write(
        base.join("uv.lock"),
        "[[package]]\nname = \"certifi\"\nversion = \"1.0\"\n",
    )
    .unwrap();
    let result = analyze_directory(base).unwrap();
    let rules: Vec<_> = result
        .dependency_issues
        .iter()
        .map(|issue| issue.rule.as_str())
        .collect();
    for rule in ["DEP001", "DEP002", "DEP003", "DEP004", "DEP005"] {
        assert!(rules.contains(&rule), "missing {rule}: {rules:?}");
    }
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .arg("--check")
        .arg(base)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("DEP001"));
}

#[test]
fn custom_import_mapping_and_ignore_avoid_false_positives() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::write(
        base.join("main.py"),
        "import yaml\nimport typing_extensions\n",
    )
    .unwrap();
    fs::write(
        base.join("pyproject.toml"),
        "[project]\ndependencies = [\"PyYAML\"]\n",
    )
    .unwrap();
    fs::write(base.join("moduleloom.toml"), "[dependencies]\nignore = [\"typing-extensions\"]\n[dependencies.import_map]\ntyping_extensions = \"typing-extensions\"\n").unwrap();
    let result = analyze_directory(base).unwrap();
    assert!(
        result.dependency_issues.is_empty(),
        "{:?}",
        result.dependency_issues
    );
}

#[test]
fn extended_architecture_rules_load_from_project_config() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::create_dir_all(base.join("app")).unwrap();
    fs::write(
        base.join("app/api.py"),
        "import app.internal\nimport app.domain\n",
    )
    .unwrap();
    fs::write(base.join("app/internal.py"), "").unwrap();
    fs::write(base.join("app/domain.py"), "").unwrap();
    fs::write(
        base.join("moduleloom.toml"),
        r#"
[architecture]
ignore_imports = ["app.api -> app.internal"]
[architecture.protected.private]
module = "app.internal"
allowed = ["app.trusted"]
[architecture.layers.app]
layers = ["app.api", "app.service", "app.domain"]
closed = ["app.service"]
"#,
    )
    .unwrap();
    let result = analyze_directory(base).unwrap();
    assert!(result
        .architecture_violations
        .iter()
        .any(|issue| issue.rule == "architecture-closed-layer"));
    assert!(!result
        .architecture_violations
        .iter()
        .any(|issue| issue.rule == "architecture-protected"));
    assert!(!result
        .architecture_violations
        .iter()
        .any(|issue| issue.rule == "architecture-unused-ignore"));
}

#[test]
fn cli_reports_shortest_import_chain() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::write(base.join("a.py"), "import b\n").unwrap();
    fs::write(base.join("b.py"), "import c\n").unwrap();
    fs::write(base.join("c.py"), "").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .args(["--chain", "a", "c"])
        .arg(base)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "a -> b -> c"
    );
}
