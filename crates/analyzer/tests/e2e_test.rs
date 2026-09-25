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
            .any(|d| d.rule.as_deref() == Some("missing-type-annotation")),
        "Should generate annotation diagnostic for untyped argument y"
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

#[test]
fn quality_report_is_machine_readable_and_score_limit_fails() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::write(base.join("a.py"), "import b\nLABEL = 'repeated-value'\ndef pick(value):\n    if value == 42:\n        return 'repeated-value'\n    return 'repeated-value'\n").unwrap();
    fs::write(base.join("b.py"), "import a\n").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .args(["--quality-report", "--max-score", "0"])
        .arg(base)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["module_count"], 2);
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["complexity"]["quality_ran"], true);
    assert!(report["complexity"]["score"].as_u64().unwrap() > 0);
    assert!(report["complexity"]["literal_findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|finding| finding["kind"] == "repeated-string"
            && finding["module"] == "a"
            && finding["line"] == 2));
    assert!(report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|finding| finding["rule"] == "literal/repeated-value"));
    assert!(report.get("modules").is_none());
}

#[test]
fn check_reports_incomplete_analysis_and_selectable_findings() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::write(base.join("broken.py"), "def broken(:\n").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .arg("--check")
        .arg(base)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Analysis error:"));

    fs::remove_file(base.join("broken.py")).unwrap();
    fs::write(base.join("a.py"), "import b\n").unwrap();
    fs::write(base.join("b.py"), "import a\n").unwrap();
    let default = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .arg("--check")
        .arg(base)
        .output()
        .unwrap();
    assert!(default.status.success());
    let cycles = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .arg("--check-cycles")
        .arg(base)
        .output()
        .unwrap();
    assert_eq!(cycles.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&cycles.stderr).contains("Cycle:"));

    let mut large = String::new();
    for _ in 0..301 {
        large.push_str("# line\n");
    }
    fs::write(base.join("large.py"), large).unwrap();
    let bloat = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .arg("--check-bloat")
        .arg(base)
        .output()
        .unwrap();
    assert_eq!(bloat.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&bloat.stderr).contains("1 selected oversized module"));
}

#[test]
fn reads_common_dependency_formats_without_optional_false_positives() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::create_dir_all(base.join("src/app")).unwrap();
    fs::create_dir_all(base.join("src/tests")).unwrap();
    fs::create_dir_all(base.join("requirements")).unwrap();
    fs::write(base.join("src/app/main.py"), "import requests\n").unwrap();
    fs::write(
        base.join("src/tests/test_main.py"),
        "import pytest\nimport hypothesis\n",
    )
    .unwrap();
    fs::write(base.join("requirements.txt"), "-r requirements/base.txt\n").unwrap();
    fs::write(base.join("requirements/base.txt"), "requests>=2\n").unwrap();
    fs::write(base.join("requirements-dev.txt"), "pytest>=8\n").unwrap();
    fs::write(base.join("pyproject.toml"), "[project.optional-dependencies]\nvisual = [\"matplotlib\"]\n[dependency-groups]\ntest = [\"hypothesis\"]\n").unwrap();
    let result = analyze_directory(base).unwrap();
    assert!(
        result.dependency_issues.is_empty(),
        "{:?}",
        result.dependency_issues
    );
    assert!(result
        .package_dependencies
        .iter()
        .any(|dep| dep.name == "matplotlib"));
    assert!(result
        .package_dependencies
        .iter()
        .any(|dep| dep.name == "requests" && dep.source == "requirements/base.txt"));
}

#[test]
fn complexity_summary_finds_duplicates_and_prioritizes_cycle_modules() {
    let root = tempdir().unwrap();
    let base = root.path();
    let repeated = "def run(value):\n    if value > 0:\n        result = value + 1\n        result *= 2\n        return result\n    return 0\n";
    fs::write(base.join("a.py"), format!("import b\n{repeated}")).unwrap();
    fs::write(base.join("b.py"), format!("import a\n{repeated}")).unwrap();
    let result = analyze_directory(base).unwrap();
    assert!(result.complexity.score > 0);
    assert!(result.complexity.imports > 0);
    assert!(result.complexity.duplicate_lines >= 10);
    assert!(result.complexity.duplication > 0);
    assert!(result
        .complexity
        .duplicate_blocks
        .iter()
        .any(|block| { block.first_module == "a" && block.second_module == "b" }));
    assert!(result
        .complexity
        .hotspots
        .iter()
        .any(|item| item.module == "a" && item.cycle));
}

#[test]
fn import_only_matches_are_not_extraction_candidates() {
    let root = tempdir().unwrap();
    let imports = "import os\nimport sys\nfrom pathlib import Path\nfrom collections import Counter\nfrom itertools import chain\nfrom functools import cache\n";
    fs::write(root.path().join("a.py"), format!("{imports}value = 1\n")).unwrap();
    fs::write(root.path().join("b.py"), format!("{imports}value = 1\n")).unwrap();
    let result = analyze_directory(root.path()).unwrap();
    assert!(result.complexity.duplicate_blocks.is_empty());
    assert_eq!(result.complexity.duplicate_lines, 0);
}

#[test]
fn diagnostics_cli_includes_duplicate_context_and_code() {
    let root = tempdir().unwrap();
    let body = "    output = []\n    for row in rows:\n        value = row.get('value', 0)\n        amount = float(value)\n        output.append(amount)\n    return output\n";
    fs::write(
        root.path().join("a.py"),
        format!("def first(rows: list) -> list:\n{body}"),
    )
    .unwrap();
    fs::write(
        root.path().join("b.py"),
        format!("def second(rows: tuple) -> list:\n{body}"),
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .arg("--diagnostics")
        .arg(root.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let candidate = &report["duplicate_candidates"][0];
    assert_eq!(candidate["first"]["file"], "a.py");
    assert_eq!(candidate["first"]["function"], "first");
    assert_eq!(candidate["second"]["function"], "second");
    assert_eq!(candidate["first"]["signature"], "(rows: list) -> list");
    assert_eq!(candidate["second"]["signature"], "(rows: tuple) -> list");
    assert!(candidate["first"]["code"]
        .as_str()
        .unwrap()
        .contains("output.append(amount)"));
    assert!(report["diagnostics"].is_array());
}

#[test]
fn generated_files_do_not_create_duplicate_candidates() {
    let root = tempdir().unwrap();
    let body = "def process(rows):\n    output = []\n    for row in rows:\n        value = row.get('value', 0)\n        amount = float(value)\n        output.append(amount)\n    return output\n";
    fs::write(root.path().join("normal.py"), body).unwrap();
    fs::write(
        root.path().join("generated.py"),
        format!("# Generated by a tool; do not edit.\n{body}"),
    )
    .unwrap();
    let result = analyze_directory(root.path()).unwrap();
    assert!(result.complexity.duplicate_blocks.is_empty());
    assert_eq!(result.complexity.duplicate_lines, 0);
}

#[test]
fn diagnostics_cli_reports_all_function_complexities_with_stable_ids() {
    let root = tempdir().unwrap();
    let source = "def choose(value):\n    if value > 0:\n        return 1\n    if value < 0:\n        return -1\n    return 0\n\ndef simple():\n    return 1\n";
    fs::write(root.path().join("a.py"), source).unwrap();
    fs::write(
        root.path().join("moduleloom.toml"),
        "[thresholds]\nmax_cyclomatic_complexity = 2\n",
    )
    .unwrap();
    let run = |override_threshold: Option<&str>| {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"));
        command
            .args(["--diagnostics", "--rule", "complexity/high-cyclomatic"])
            .env("PATH", "");
        if let Some(threshold) = override_threshold {
            command.args(["--max-ccn", threshold]);
        }
        let output = command.arg(root.path()).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let first = run(None);
    assert_eq!(first["schema_version"], 1);
    assert_eq!(first["thresholds"]["max_cyclomatic_complexity"], 2);
    assert_eq!(
        first["complexity"]["function_complexities"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(first["findings"].as_array().unwrap().len(), 1);
    assert_eq!(first["findings"][0]["metric"]["value"], 3);
    assert_eq!(first["findings"][0]["source"], "ModuleLoom");
    assert_eq!(first["findings"][0]["location"]["symbol"], "choose");
    let id = first["findings"][0]["id"].clone();
    let annotation_ids = || {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
            .args(["--findings-only", "--rule", "missing-type-annotation"])
            .env("PATH", "")
            .arg(root.path())
            .output()
            .unwrap();
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        report["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|finding| finding["id"].clone())
            .collect::<Vec<_>>()
    };
    let annotations_before = annotation_ids();
    fs::write(root.path().join("a.py"), format!("\n{source}")).unwrap();
    let shifted = run(None);
    assert_eq!(shifted["findings"][0]["id"], id);
    assert_eq!(shifted["findings"][0]["location"]["line"], 2);
    assert_eq!(annotation_ids(), annotations_before);
    let relaxed = run(Some("3"));
    assert!(relaxed["findings"].as_array().unwrap().is_empty());
    let compact = std::process::Command::new(env!("CARGO_BIN_EXE_analyze"))
        .args(["--findings-only", "--rule", "complexity/*"])
        .env("PATH", "")
        .arg(root.path())
        .output()
        .unwrap();
    assert!(compact.status.success());
    let compact: serde_json::Value = serde_json::from_slice(&compact.stdout).unwrap();
    assert!(compact.get("complexity").is_none());
    assert_eq!(compact["findings"].as_array().unwrap().len(), 1);
}

#[test]
fn complexity_counts_mutual_imports_even_when_deferred() {
    let root = tempdir().unwrap();
    let base = root.path();
    fs::write(base.join("a.py"), "def run():\n    import b\n").unwrap();
    fs::write(base.join("b.py"), "def run():\n    import a\n").unwrap();
    let result = analyze_directory(base).unwrap();
    assert!(result.cycles.is_empty());
    assert!(result.complexity.imports > 0);
    assert!(result
        .complexity
        .hotspots
        .iter()
        .all(|item| item.mutual_import && !item.cycle));
}
