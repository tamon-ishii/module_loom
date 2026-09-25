use moduleloom_analyzer::model::{AnalysisResult, DuplicateBlock};
use moduleloom_analyzer::{analyze_directory, analyze_directory_incremental, load_config};
use serde::Deserialize;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[path = "analyze/findings.rs"]
mod findings;

#[derive(Deserialize)]
struct IncrementalInput {
    previous: AnalysisResult,
    changed_files: Vec<PathBuf>,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut json_mode = false;
    let mut check_mode = false;
    let mut check_cycles = false;
    let mut check_bloat = false;
    let mut incremental_mode = false;
    let mut quality_mode = false;
    let mut quality_report = false;
    let mut findings_only = false;
    let mut max_score: Option<usize> = None;
    let mut max_ccn: Option<usize> = None;
    let mut selected_rules: Vec<String> = Vec::new();
    let mut chain_from: Option<&str> = None;
    let mut chain_to: Option<&str> = None;
    let mut chain_requested = false;
    let mut mkdocs_output: Option<&str> = None;
    let mut mkdocs_lang = "auto";
    let mut target = ".";

    let mut arguments = args.iter().skip(1);
    while let Some(arg) = arguments.next() {
        if arg == "--help" || arg == "-h" {
            println!("Usage: moduleloom-analyze [OPTIONS] [PROJECT_PATH]");
            println!("  --diagnostics      Run code diagnostics and print AI-ready JSON");
            println!("  --quality-report   Alias of --diagnostics");
            println!("  --quality --json   Print the full analysis with diagnostics");
            println!("  --max-score N      Exit with status 1 if the score exceeds N");
            println!("  --max-ccn N        Override the function complexity threshold");
            println!(
                "  --rule RULE        Keep matching findings (repeatable, * suffix for prefix)"
            );
            println!("  --findings-only    Print compact findings JSON");
            return;
        } else if arg == "--json" {
            json_mode = true;
        } else if arg == "--check" {
            check_mode = true;
        } else if arg == "--check-cycles" {
            check_mode = true;
            check_cycles = true;
        } else if arg == "--check-bloat" {
            check_mode = true;
            check_bloat = true;
        } else if arg == "--check-all" {
            check_mode = true;
            check_cycles = true;
            check_bloat = true;
        } else if arg == "--incremental" {
            incremental_mode = true;
        } else if arg == "--quality" {
            quality_mode = true;
        } else if arg == "--quality-report" || arg == "--diagnostics" {
            quality_mode = true;
            quality_report = true;
            json_mode = true;
        } else if arg == "--max-score" {
            max_score = match arguments
                .next()
                .and_then(|value| value.parse::<usize>().ok())
            {
                Some(value) if value <= 100 => Some(value),
                _ => {
                    eprintln!("Usage: moduleloom-analyze --max-score 0..100 [PROJECT_PATH]");
                    std::process::exit(2);
                }
            };
            quality_mode = true;
        } else if arg == "--max-ccn" {
            max_ccn = match arguments
                .next()
                .and_then(|value| value.parse::<usize>().ok())
            {
                Some(value) if value > 0 => Some(value),
                _ => {
                    eprintln!(
                        "Usage: moduleloom-analyze --max-ccn POSITIVE_INTEGER [PROJECT_PATH]"
                    );
                    std::process::exit(2);
                }
            };
            quality_mode = true;
            quality_report = true;
            json_mode = true;
        } else if arg == "--rule" {
            let Some(rule) = arguments.next().filter(|value| !value.starts_with("--")) else {
                eprintln!("Usage: moduleloom-analyze --rule RULE [PROJECT_PATH]");
                std::process::exit(2);
            };
            selected_rules.push(rule.clone());
            quality_mode = true;
            quality_report = true;
            json_mode = true;
        } else if arg == "--findings-only" {
            findings_only = true;
            quality_mode = true;
            quality_report = true;
            json_mode = true;
        } else if arg == "--chain" {
            chain_requested = true;
            chain_from = arguments.next().map(String::as_str);
            chain_to = arguments.next().map(String::as_str);
        } else if arg == "--mkdocs" {
            mkdocs_output = arguments.next().map(String::as_str);
            if mkdocs_output.is_none_or(|value| value.starts_with("--")) {
                eprintln!("Usage: moduleloom-analyze --mkdocs OUTPUT_DIR [PROJECT_PATH]");
                std::process::exit(2);
            }
        } else if arg == "--lang" {
            mkdocs_lang = arguments.next().map(String::as_str).unwrap_or("auto");
        } else if !arg.starts_with("--") {
            target = arg;
        }
    }
    if chain_requested
        && (chain_from.is_none()
            || chain_to.is_none()
            || chain_from.is_some_and(|value| value.starts_with("--"))
            || chain_to.is_some_and(|value| value.starts_with("--")))
    {
        eprintln!("Usage: moduleloom-analyze --chain SOURCE TARGET [PROJECT_PATH]");
        std::process::exit(2);
    }

    let result = if incremental_mode {
        let mut input = String::new();
        match std::io::stdin().read_to_string(&mut input) {
            Ok(_) => match serde_json::from_str::<IncrementalInput>(&input) {
                Ok(request) => analyze_directory_incremental(
                    Path::new(target),
                    &request.previous,
                    &request.changed_files,
                ),
                Err(error) => Err(format!("Invalid incremental input: {error}")),
            },
            Err(error) => Err(format!("Failed to read incremental input: {error}")),
        }
    } else {
        analyze_directory(Path::new(target))
    };

    match result {
        Ok(mut res) => {
            if quality_mode {
                moduleloom_analyzer::enrich_quality(&mut res);
            }
            if let Some(output) = mkdocs_output {
                if let Err(error) = moduleloom_analyzer::mkdocs::generate_with_lang(
                    &res,
                    Path::new(output),
                    mkdocs_lang,
                ) {
                    eprintln!("MkDocs generation failed: {error}");
                    std::process::exit(1);
                }
                if !json_mode {
                    println!("MkDocs project generated: {output}");
                }
            }
            if let (Some(source), Some(destination)) = (chain_from, chain_to) {
                if !res.modules.iter().any(|module| module.id == source)
                    || !res.modules.iter().any(|module| module.id == destination)
                {
                    eprintln!("Unknown module in import chain query: {source} -> {destination}");
                    std::process::exit(2);
                }
                let path =
                    moduleloom_analyzer::graph::shortest_chain(&res.edges, source, destination);
                if json_mode {
                    println!("{}", serde_json::to_string(&path).unwrap());
                } else if let Some(path) = path {
                    println!("{}", path.join(" -> "));
                } else {
                    println!("No import chain: {source} -> {destination}");
                }
                return;
            }
            if json_mode {
                let output = if quality_report {
                    let threshold = match max_ccn {
                        Some(value) => value,
                        None => match load_config(Path::new(target)) {
                            Ok(config) => config.max_cyclomatic_complexity,
                            Err(error) => {
                                eprintln!("{error}");
                                std::process::exit(2);
                            }
                        },
                    };
                    let mut findings = findings::build(&res, threshold);
                    if !selected_rules.is_empty() {
                        findings.retain(|finding| {
                            selected_rules.iter().any(|selected| {
                                let rule = finding["rule"].as_str().unwrap_or("");
                                selected
                                    .strip_suffix('*')
                                    .map_or(rule == selected, |prefix| rule.starts_with(prefix))
                            })
                        });
                    }
                    if findings_only {
                        serde_json::json!({
                            "schema_version": 1,
                            "thresholds": {"max_cyclomatic_complexity": threshold},
                            "findings": findings,
                            "root_path": res.root_path,
                            "quality_warnings": res.complexity.quality_warnings,
                        })
                    } else {
                        serde_json::json!({
                            "schema_version": 1,
                            "thresholds": {"max_cyclomatic_complexity": threshold},
                            "findings": findings,
                            "root_path": res.root_path,
                            "module_count": res.modules.len(),
                            "total_loc": res.total_loc,
                            "complexity": res.complexity,
                            "duplicate_candidates": res.complexity.duplicate_blocks.iter()
                                .map(|block| duplicate_candidate(&res, block))
                                .collect::<Vec<_>>(),
                            "diagnostics": res.modules.iter().flat_map(|module| {
                                module.diagnostics.iter().map(move |diagnostic| serde_json::json!({
                                    "module": module.id,
                                    "file": module.relative_path,
                                    "diagnostic": diagnostic,
                                }))
                            }).collect::<Vec<_>>(),
                            "type_diagnostics": res.modules.iter().flat_map(|module| {
                                module.diagnostics.iter()
                                    .filter(|diagnostic| diagnostic.rule.as_deref().is_some_and(|rule| rule.starts_with("ty/")))
                                    .map(move |diagnostic| serde_json::json!({
                                        "module": module.id,
                                        "file": module.relative_path,
                                        "diagnostic": diagnostic,
                                    }))
                            }).collect::<Vec<_>>(),
                            "cycles": res.cycles,
                            "architecture_violations": res.architecture_violations,
                            "dependency_issues": res.dependency_issues,
                            "analysis_errors": res.analysis_errors,
                        })
                    }
                } else {
                    serde_json::to_value(&res).unwrap()
                };
                match serde_json::to_string(&output) {
                    Ok(json_str) => println!("{}", json_str),
                    Err(e) => {
                        eprintln!("Failed to serialize result to JSON: {}", e);
                        std::process::exit(1);
                    }
                }
            } else {
                println!("Analyzing: {}", target);
                println!("Modules found: {}", res.modules.len());
                println!("Edges found: {}", res.edges.len());
                println!("Cycles found: {}", res.cycles.len());
                println!(
                    "Architecture violations: {}",
                    res.architecture_violations.len()
                );
                println!("Dependency issues: {}", res.dependency_issues.len());
                for c in &res.cycles {
                    println!("  Cycle: {:?}", c.modules);
                }
                let bloat = res.modules.iter().filter(|m| m.is_oversized).count();
                println!("Bloated modules: {}", bloat);
                if quality_mode {
                    println!("Complexity score: {}/100", res.complexity.score);
                    println!("Code source: {}", res.complexity.code_source);
                    println!("Duplication source: {}", res.complexity.duplication_source);
                    println!(
                        "Literal findings: {}",
                        res.complexity.literal_findings.len()
                    );
                }
            }
            let oversized = res
                .modules
                .iter()
                .filter(|module| module.is_oversized)
                .count();
            let score_exceeded = max_score.is_some_and(|limit| res.complexity.score > limit);
            if (check_mode || score_exceeded)
                && (score_exceeded
                    || !res.analysis_errors.is_empty()
                    || !res.architecture_violations.is_empty()
                    || !res.dependency_issues.is_empty()
                    || (check_cycles && !res.cycles.is_empty())
                    || (check_bloat && oversized > 0))
            {
                for error in &res.analysis_errors {
                    eprintln!("Analysis error: {error}");
                }
                for issue in &res.architecture_violations {
                    eprintln!(
                        "{} {}: {} -> {}",
                        issue.rule, issue.name, issue.source, issue.target
                    );
                }
                for issue in &res.dependency_issues {
                    eprintln!(
                        "{} {}: {}{}",
                        issue.rule,
                        issue.package,
                        issue.message,
                        issue
                            .module
                            .as_ref()
                            .map(|module| format!(" ({module})"))
                            .unwrap_or_default()
                    );
                }
                if check_cycles {
                    for cycle in &res.cycles {
                        eprintln!("Cycle: {}", cycle.path.join(" -> "));
                    }
                }
                eprintln!(
                    "Check failed: {} analysis error(s), {} architecture violation(s), {} dependency issue(s), {} selected cycle(s), {} selected oversized module(s)",
                    res.analysis_errors.len(),
                    res.architecture_violations.len(),
                    res.dependency_issues.len(),
                    if check_cycles { res.cycles.len() } else { 0 },
                    if check_bloat { oversized } else { 0 }
                );
                if let Some(limit) = max_score {
                    if score_exceeded {
                        eprintln!(
                            "Complexity score {} exceeds limit {}",
                            res.complexity.score, limit
                        );
                    }
                }
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}

fn duplicate_candidate(res: &AnalysisResult, block: &DuplicateBlock) -> serde_json::Value {
    let location =
        |module_id: &str, start: usize, function: &Option<String>, signature: &Option<String>| {
            let module = res.modules.iter().find(|module| module.id == module_id);
            let snippet = module
                .and_then(|module| fs::read_to_string(&module.absolute_path).ok())
                .map(|source| {
                    source
                        .lines()
                        .skip(start.saturating_sub(1))
                        .take(block.lines.min(30))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
            serde_json::json!({
                "module": module_id,
                "file": module.map(|module| &module.relative_path),
                "start_line": start,
                "end_line": start + block.lines - 1,
                "function": function,
                "signature": signature,
                "code": snippet,
                "code_truncated": block.lines > 30,
            })
        };
    let extraction =
        block.lines >= 10 && block.first_function.is_some() && block.second_function.is_some();
    serde_json::json!({
        "kind": block.kind,
        "matched_lines": block.lines,
        "suggestion": if extraction { "consider_shared_function" } else { "review_duplicate" },
        "reason": if extraction { "repeated_logic_in_functions" } else if block.kind == "renamed" { "matching_structure" } else { "matching_code" },
        "first": location(&block.first_module, block.first_line, &block.first_function, &block.first_signature),
        "second": location(&block.second_module, block.second_line, &block.second_function, &block.second_signature),
    })
}
