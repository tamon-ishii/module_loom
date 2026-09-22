use crate::model::*;

pub struct BloatThresholds {
    pub max_loc: usize,
    pub max_functions: usize,
    pub max_classes: usize,
}

impl Default for BloatThresholds {
    fn default() -> Self {
        Self {
            max_loc: 300,
            max_functions: 20,
            max_classes: 10,
        }
    }
}

pub fn check_bloat(mod_info: &ModuleInfo, thresholds: &BloatThresholds) -> Option<Diagnostic> {
    let mut reasons = Vec::new();

    if mod_info.loc > thresholds.max_loc {
        reasons.push(format!("行数超過 (LOC: {} > {})", mod_info.loc, thresholds.max_loc));
    }
    if mod_info.function_count > thresholds.max_functions {
        reasons.push(format!("関数定義数超過 ({} > {})", mod_info.function_count, thresholds.max_functions));
    }
    if mod_info.class_count > thresholds.max_classes {
        reasons.push(format!("クラス定義数超過 ({} > {})", mod_info.class_count, thresholds.max_classes));
    }

    if !reasons.is_empty() {
        Some(Diagnostic {
            severity: DiagnosticSeverity::Warning,
            message: format!("モジュール肥大化警告: {}", reasons.join(", ")),
            line: Some(1),
            rule: Some("module-bloat".to_string()),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_bloat_detection() {
        let normal_mod = ModuleInfo {
            id: "normal".to_string(),
            name: "normal".to_string(),
            relative_path: "normal.py".to_string(),
            absolute_path: PathBuf::from("normal.py"),
            docstring: None,
            loc: 100,
            class_count: 2,
            classes: vec![],
            function_count: 5,
            functions: vec![],
            imports: vec![],
            is_oversized: false,
            diagnostics: vec![],
        };

        let bloated_mod = ModuleInfo {
            id: "bloated".to_string(),
            name: "bloated".to_string(),
            relative_path: "bloated.py".to_string(),
            absolute_path: PathBuf::from("bloated.py"),
            docstring: None,
            loc: 500,
            class_count: 15,
            classes: vec![],
            function_count: 30,
            functions: vec![],
            imports: vec![],
            is_oversized: true,
            diagnostics: vec![],
        };

        let thresholds = BloatThresholds::default();
        assert!(check_bloat(&normal_mod, &thresholds).is_none());

        let diag = check_bloat(&bloated_mod, &thresholds);
        assert!(diag.is_some());
        let msg = diag.unwrap().message;
        assert!(msg.contains("LOC: 500"));
        assert!(msg.contains("30 > 20"));
    }
}
