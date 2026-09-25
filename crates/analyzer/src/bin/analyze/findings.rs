use moduleloom_analyzer::model::{AnalysisResult, DiagnosticSeverity};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;

pub fn build(result: &AnalysisResult, max_ccn: usize) -> Vec<Value> {
    let mut findings = Vec::new();

    for function in &result.complexity.function_complexities {
        if function.ccn <= max_ccn {
            continue;
        }
        let rule = "complexity/high-cyclomatic";
        findings.push(json!({
            "id": stable_id(&[rule, &function.file, &function.name]),
            "rule": rule,
            "severity": "warning",
            "source": function.source,
            "confidence": if function.source == "Lizard" { "high" } else { "medium" },
            "message": format!("Function {} has cyclomatic complexity {} (threshold {})", function.name, function.ccn, max_ccn),
            "location": location(Some(&function.file), Some(function.line), Some(&function.name)),
            "related_locations": [],
            "metric": {"name": "cyclomatic_complexity", "value": function.ccn, "threshold": max_ccn},
            "evidence": {"function": function.name},
            "suggestion": {"kind": "reduce_branching", "rationale": "Inspect independent branches and extract cohesive operations; preserve behavior with tests.", "safety": "review"},
            "verification": {"recheck_rule": rule},
        }));
    }

    for block in &result.complexity.duplicate_blocks {
        let evidence = super::duplicate_candidate(result, block);
        let first = &evidence["first"];
        let second = &evidence["second"];
        let first_file = first["file"].as_str().unwrap_or("");
        let second_file = second["file"].as_str().unwrap_or("");
        let first_symbol = block.first_function.as_deref().unwrap_or("");
        let second_symbol = block.second_function.as_deref().unwrap_or("");
        let code = first["code"].as_str().unwrap_or("");
        let rule = "duplication/repeated-code";
        let suggestion = evidence["suggestion"]
            .as_str()
            .unwrap_or("review_duplicate");
        findings.push(json!({
            "id": stable_id(&[rule, first_file, first_symbol, second_file, second_symbol, code]),
            "rule": rule,
            "severity": "warning",
            "source": result.complexity.duplication_source,
            "confidence": if block.kind == "exact" { "high" } else { "medium" },
            "message": format!("{} matching lines between {} and {}", block.lines, first_file, second_file),
            "location": location(Some(first_file), Some(block.first_line), block.first_function.as_deref()),
            "related_locations": [location(Some(second_file), Some(block.second_line), block.second_function.as_deref())],
            "metric": {"name": "matching_lines", "value": block.lines},
            "evidence": evidence,
            "suggestion": {"kind": suggestion, "rationale": "Compare parameters, return behavior, side effects, and error handling before sharing code.", "safety": "review"},
            "verification": {"recheck_rule": rule},
        }));
    }

    for module in &result.modules {
        let source = fs::read_to_string(&module.absolute_path).unwrap_or_default();
        let source_lines: Vec<&str> = source.lines().collect();
        for diagnostic in &module.diagnostics {
            if matches!(
                diagnostic.rule.as_deref(),
                Some("duplicate-code" | "similar-code")
            ) {
                continue;
            }
            let rule = diagnostic
                .rule
                .as_deref()
                .unwrap_or("moduleloom/diagnostic");
            let line = diagnostic.line;
            let source_line = line
                .and_then(|number| source_lines.get(number.saturating_sub(1)))
                .map(|line| line.trim())
                .unwrap_or("");
            let severity = match diagnostic.severity {
                DiagnosticSeverity::Info => "info",
                DiagnosticSeverity::Warning => "warning",
                DiagnosticSeverity::Error => "error",
            };
            let heuristic = rule == "missing-type-annotation";
            let id = if rule == "module-bloat" {
                stable_id(&[rule, &module.relative_path])
            } else {
                stable_id(&[
                    rule,
                    &module.relative_path,
                    source_line,
                    &diagnostic.message,
                ])
            };
            findings.push(json!({
                "id": id,
                "rule": rule,
                "severity": if heuristic { "info" } else { severity },
                "source": if rule.starts_with("ty/") { "ty" } else { "ModuleLoom" },
                "confidence": if heuristic { "low" } else if rule.starts_with("ty/") { "high" } else { "medium" },
                "message": diagnostic.message,
                "location": location(Some(&module.relative_path), line, None),
                "related_locations": [],
                "metric": null,
                "evidence": {"source_line": source_line},
                "suggestion": {"kind": "review_diagnostic", "safety": "review"},
                "verification": {"recheck_rule": rule},
            }));
        }
    }

    for literal in &result.complexity.literal_findings {
        let module = result
            .modules
            .iter()
            .find(|module| module.id == literal.module);
        let file = module.map(|module| module.relative_path.as_str());
        let rule = if literal.kind == "magic-number" {
            "ruff/PLR2004"
        } else {
            "literal/repeated-value"
        };
        findings.push(json!({
            "id": stable_id(&[rule, file.unwrap_or(""), &literal.value]),
            "rule": rule,
            "severity": "info",
            "source": if literal.kind == "magic-number" { "Ruff" } else { "ModuleLoom" },
            "confidence": "medium",
            "message": format!("{}: {}", literal.kind, literal.value),
            "location": location(file, Some(literal.line), None),
            "related_locations": [],
            "metric": {"name": "occurrences", "value": literal.count},
            "evidence": {"value": literal.value, "kind": literal.kind},
            "suggestion": {"kind": "consider_named_constant", "safety": "review"},
            "verification": {"recheck_rule": rule},
        }));
    }

    for violation in &result.architecture_violations {
        let module = result
            .modules
            .iter()
            .find(|module| module.id == violation.source);
        let file = module.map(|module| module.relative_path.as_str());
        let rule = format!("architecture/{}", violation.rule);
        findings.push(json!({
            "id": stable_id(&[&rule, &violation.source, &violation.target]),
            "rule": rule,
            "severity": "error",
            "source": "ModuleLoom",
            "confidence": "high",
            "message": violation.message,
            "location": location(file, Some(violation.line), None),
            "related_locations": [],
            "metric": null,
            "evidence": {"source_module": violation.source, "target_module": violation.target},
            "suggestion": {"kind": "respect_architecture_rule", "rationale": violation.suggestion, "safety": "review"},
            "verification": {"recheck_rule": rule},
        }));
    }

    for cycle in &result.cycles {
        let rule = "architecture/circular-import";
        let source_module = cycle
            .suggestion
            .as_ref()
            .map(|suggestion| suggestion.source.as_str())
            .or_else(|| cycle.path.first().map(String::as_str));
        let module =
            source_module.and_then(|id| result.modules.iter().find(|module| module.id == id));
        let file = module.map(|module| module.relative_path.as_str());
        let line = cycle.suggestion.as_ref().map(|suggestion| suggestion.line);
        findings.push(json!({
            "id": stable_id(&[rule, &cycle.modules.join("|"), &cycle.path.join("|")]),
            "rule": rule,
            "severity": "warning",
            "source": "ModuleLoom",
            "confidence": "medium",
            "message": format!("Circular import: {}", cycle.path.join(" -> ")),
            "location": location(file, line, None),
            "related_locations": [],
            "metric": {"name": "cycle_modules", "value": cycle.modules.len()},
            "evidence": {"path": cycle.path, "modules": cycle.modules, "suggestion": cycle.suggestion},
            "suggestion": {"kind": "break_import_cycle", "rationale": "Review the runtime and type-only references before moving an import.", "safety": "review"},
            "verification": {"recheck_rule": rule},
        }));
    }

    for issue in &result.dependency_issues {
        let module = issue
            .module
            .as_ref()
            .and_then(|id| result.modules.iter().find(|module| module.id == *id));
        let file = module.map(|module| module.relative_path.as_str());
        let rule = format!("dependency/{}", issue.rule);
        findings.push(json!({
            "id": stable_id(&[&rule, issue.module.as_deref().unwrap_or(""), &issue.package]),
            "rule": rule,
            "severity": "warning",
            "source": "ModuleLoom",
            "confidence": "medium",
            "message": issue.message,
            "location": location(file, None, None),
            "related_locations": [],
            "metric": null,
            "evidence": {"package": issue.package, "module": issue.module},
            "suggestion": {"kind": "review_dependency_declaration", "safety": "review"},
            "verification": {"recheck_rule": rule},
        }));
    }

    for error in &result.analysis_errors {
        let rule = "analysis/parse-error";
        findings.push(json!({
            "id": stable_id(&[rule, error]),
            "rule": rule,
            "severity": "error",
            "source": "ModuleLoom",
            "confidence": "high",
            "message": error,
            "location": location(None, None, None),
            "related_locations": [],
            "metric": null,
            "evidence": null,
            "suggestion": {"kind": "repair_parse_error", "safety": "review"},
            "verification": {"recheck_rule": rule},
        }));
    }

    findings.sort_by(|a, b| {
        let severity_rank = |value: &Value| match value["severity"].as_str() {
            Some("error") => 0,
            Some("warning") => 1,
            _ => 2,
        };
        let key = |value: &Value| {
            (
                severity_rank(value),
                if matches!(
                    value["rule"].as_str(),
                    Some("complexity/high-cyclomatic" | "duplication/repeated-code")
                ) {
                    0
                } else {
                    1
                },
                value["location"]["file"].as_str().unwrap_or("").to_string(),
                value["location"]["line"].as_u64().unwrap_or(0),
                value["rule"].as_str().unwrap_or("").to_string(),
                value["id"].as_str().unwrap_or("").to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    let mut repeated_ids = HashMap::new();
    for finding in &mut findings {
        let Some(base) = finding["id"].as_str().map(str::to_string) else {
            continue;
        };
        let occurrence = repeated_ids.entry(base.clone()).or_insert(0_usize);
        *occurrence += 1;
        if *occurrence > 1 {
            finding["id"] = json!(format!("{base}-{}", occurrence));
        }
    }
    findings
}

fn location(file: Option<&str>, line: Option<usize>, symbol: Option<&str>) -> Value {
    json!({"file": file, "line": line, "symbol": symbol})
}

fn stable_id(parts: &[&str]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in part.as_bytes().iter().chain(std::iter::once(&0_u8)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("finding-{hash:016x}")
}
