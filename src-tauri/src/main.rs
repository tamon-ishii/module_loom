// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use moduleloom_analyzer::model::AnalysisResult;

#[tauri::command]
fn analyze_project(path: String) -> Result<AnalysisResult, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    moduleloom_analyzer::analyze_directory(&p)
}

#[tauri::command]
fn open_in_editor(editor: String, file_path: String, line: Option<usize>) -> Result<(), String> {
    let line_num = line.unwrap_or(1);
    match editor.as_str() {
        "vscode" => {
            let url = format!("vscode://file/{}:{}", file_path, line_num);
            if open::that(&url).is_err() {
                let _ = std::process::Command::new("code")
                    .arg("-g")
                    .arg(format!("{}:{}", file_path, line_num))
                    .spawn();
            }
        }
        "pycharm" => {
            let url = format!("jetbrains://pycharm/navigate/reference?path={}:{}", file_path, line_num);
            if open::that(&url).is_err() {
                // Try pycharm CLI commands in order
                let commands = ["pycharm", "pycharm-community", "pycharm.sh"];
                let mut launched = false;
                for cmd in commands {
                    if let Ok(_) = std::process::Command::new(cmd)
                        .arg("--line")
                        .arg(line_num.to_string())
                        .arg(&file_path)
                        .spawn()
                    {
                        launched = true;
                        break;
                    }
                }
                if !launched {
                    eprintln!("Warning: Could not launch PyCharm CLI automatically. URL: {}", url);
                }
            }
        }
        _ => return Err(format!("Unsupported editor: {}", editor)),
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![analyze_project, open_in_editor])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
