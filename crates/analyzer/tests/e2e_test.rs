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
        r#"from pkg_b.mod2 import func2

def func1(x: int) -> int:
    return func2(x)
"#,
    ).unwrap();

    fs::write(
        pkg_b.join("mod2.py"),
        r#"from pkg_a.mod1 import func1

def func2(y):
    return y * 2
"#,
    ).unwrap();

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
    assert_eq!(result.cycles.len(), 1, "Must detect 1 circular import cycle");
    let cycle = &result.cycles[0];
    assert!(cycle.modules.contains(&"pkg_a.mod1".to_string()));
    assert!(cycle.modules.contains(&"pkg_b.mod2".to_string()));

    // 3. Verify edges and circular flags
    assert_eq!(result.edges.len(), 2);
    assert!(result.edges.iter().all(|e| e.is_circular));

    // 4. Verify bloat detection
    let giant_mod = result.modules.iter().find(|m| m.id == "pkg_c.giant").expect("Find giant");
    assert!(giant_mod.is_oversized, "Giant module must be flagged as oversized");
    assert!(giant_mod.loc > 300);

    // 5. Verify type check diagnostic (func2 has untyped argument y)
    let mod2 = result.modules.iter().find(|m| m.id == "pkg_b.mod2").expect("Find mod2");
    assert!(
        mod2.diagnostics.iter().any(|d| d.rule.as_deref() == Some("ty-type-check")),
        "Should generate type check diagnostic for untyped argument y"
    );
}
