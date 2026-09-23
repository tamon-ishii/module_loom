use moduleloom_analyzer::model::AnalysisResult;
use moduleloom_analyzer::{analyze_directory, analyze_directory_incremental};
use serde::Deserialize;
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct IncrementalInput {
    previous: AnalysisResult,
    changed_files: Vec<PathBuf>,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut json_mode = false;
    let mut check_mode = false;
    let mut incremental_mode = false;
    let mut chain_from: Option<&str> = None;
    let mut chain_to: Option<&str> = None;
    let mut chain_requested = false;
    let mut mkdocs_output: Option<&str> = None;
    let mut mkdocs_lang = "auto";
    let mut target = ".";

    let mut arguments = args.iter().skip(1);
    while let Some(arg) = arguments.next() {
        if arg == "--json" {
            json_mode = true;
        } else if arg == "--check" {
            check_mode = true;
        } else if arg == "--incremental" {
            incremental_mode = true;
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
        Ok(res) => {
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
                match serde_json::to_string(&res) {
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
            }
            if check_mode
                && (!res.architecture_violations.is_empty() || !res.dependency_issues.is_empty())
            {
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
                eprintln!(
                    "Check failed: {} architecture violation(s), {} dependency issue(s)",
                    res.architecture_violations.len(),
                    res.dependency_issues.len()
                );
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}
