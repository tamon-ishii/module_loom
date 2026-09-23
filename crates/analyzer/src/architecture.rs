use crate::model::*;

pub fn check_architecture(
    modules: &[ModuleInfo],
    edges: &[DependencyEdge],
    config: &ArchitectureConfig,
) -> Vec<ArchitectureViolation> {
    let mut violations = Vec::new();

    for edge in edges {
        for rule in &config.forbidden {
            if matches_prefix(&edge.source, &rule.source)
                && matches_prefix(&edge.target, &rule.target)
            {
                violations.push(ArchitectureViolation {
                    rule: "architecture-forbidden".to_string(),
                    name: rule.name.clone(),
                    source: edge.source.clone(),
                    target: edge.target.clone(),
                    line: edge.line,
                    message: format!("禁止された依存: {} -> {}", edge.source, edge.target),
                    suggestion: "依存方向を反転するか、共通インターフェースを下位モジュールへ抽出してください".to_string(),
                });
            }
        }

        for rule in &config.independence {
            let source_group = matching_group(&edge.source, &rule.modules);
            let target_group = matching_group(&edge.target, &rule.modules);
            if source_group.is_some() && target_group.is_some() && source_group != target_group {
                violations.push(ArchitectureViolation {
                    rule: "architecture-independence".to_string(),
                    name: rule.name.clone(),
                    source: edge.source.clone(),
                    target: edge.target.clone(),
                    line: edge.line,
                    message: format!("独立性ルール違反: {} -> {}", edge.source, edge.target),
                    suggestion:
                        "共有処理を別パッケージへ移すか、依存性注入で直接依存をなくしてください"
                            .to_string(),
                });
            }
        }

        for rule in &config.layers {
            let source_layer = layer_index(&edge.source, &rule.layers);
            let target_layer = layer_index(&edge.target, &rule.layers);
            if let (Some(source), Some(target)) = (source_layer, target_layer) {
                // The list is ordered from high level to low level. Low levels
                // must not import higher levels.
                if source > target {
                    violations.push(ArchitectureViolation {
                        rule: "architecture-layers".to_string(),
                        name: rule.name.clone(),
                        source: edge.source.clone(),
                        target: edge.target.clone(),
                        line: edge.line,
                        message: format!("レイヤー違反: {} -> {}", edge.source, edge.target),
                        suggestion: "下位レイヤーから上位レイヤーへの依存を取り除いてください"
                            .to_string(),
                    });
                }
            }
        }
    }

    let _ = modules;
    violations
}

fn matches_prefix(module: &str, prefix: &str) -> bool {
    module == prefix || module.starts_with(&format!("{}.", prefix))
}

fn matching_group(module: &str, groups: &[String]) -> Option<usize> {
    groups
        .iter()
        .position(|group| matches_prefix(module, group))
}

fn layer_index(module: &str, layers: &[String]) -> Option<usize> {
    matching_group(module, layers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_forbidden_dependency() {
        let modules = vec![];
        let edges = vec![DependencyEdge {
            source: "app.api.routes".into(),
            target: "app.db.models".into(),
            is_circular: false,
            line: 4,
            import_count: 1,
            is_top_level: true,
        }];
        let config = ArchitectureConfig {
            forbidden: vec![ForbiddenImportRule {
                name: "api-db".into(),
                source: "app.api".into(),
                target: "app.db".into(),
            }],
            ..Default::default()
        };
        assert_eq!(check_architecture(&modules, &edges, &config).len(), 1);
    }
}
