use std::env;
use std::path::Path;
use moduleloom_analyzer::analyze_directory;

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut json_mode = false;
    let mut target = ".";

    for arg in args.iter().skip(1) {
        if arg == "--json" {
            json_mode = true;
        } else if !arg.starts_with("--") {
            target = arg;
        }
    }

    match analyze_directory(Path::new(target)) {
        Ok(res) => {
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
                for c in &res.cycles {
                    println!("  Cycle: {:?}", c.modules);
                }
                let bloat = res.modules.iter().filter(|m| m.is_oversized).count();
                println!("Bloated modules: {}", bloat);
            }
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}
