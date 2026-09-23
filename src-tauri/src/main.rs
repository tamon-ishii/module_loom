// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use moduleloom_analyzer::model::AnalysisResult;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, State};

struct WatchState {
    stop_sender: Mutex<Option<mpsc::Sender<()>>>,
}

#[tauri::command]
fn analyze_project(path: String) -> Result<AnalysisResult, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    moduleloom_analyzer::analyze_directory(&p)
}

#[tauri::command]
fn watch_project(path: String, app: AppHandle, state: State<'_, WatchState>) -> Result<(), String> {
    let project_path = PathBuf::from(&path);
    if !project_path.is_dir() {
        return Err("Project path must be a directory".to_string());
    }

    let (stop_sender, stop_receiver) = mpsc::channel();
    {
        let mut current_sender = state
            .stop_sender
            .lock()
            .map_err(|_| "Watcher state is unavailable".to_string())?;
        if let Some(previous) = current_sender.take() {
            let _ = previous.send(());
        }
        *current_sender = Some(stop_sender);
    }

    thread::spawn(move || {
        let mut previous = collect_python_files(&project_path);
        loop {
            if stop_receiver
                .recv_timeout(Duration::from_millis(700))
                .is_ok()
            {
                break;
            }
            let current = collect_python_files(&project_path);
            if current != previous {
                let changed_path = current.keys().next().or_else(|| previous.keys().next());
                if let Some(changed_path) = changed_path {
                    let _ = app.emit(
                        "project-changed",
                        changed_path.to_string_lossy().to_string(),
                    );
                }
                previous = current;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_watching(state: State<'_, WatchState>) -> Result<(), String> {
    let mut sender = state
        .stop_sender
        .lock()
        .map_err(|_| "Watcher state is unavailable".to_string())?;
    if let Some(sender) = sender.take() {
        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
fn git_changed_files(path: String) -> Result<Vec<String>, String> {
    let project_path = PathBuf::from(&path);
    if !project_path.is_dir() {
        return Err("Project path must be a directory".to_string());
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["status", "--short"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.get(3..).map(str::trim))
        .filter(|file| file.ends_with(".py"))
        .map(str::to_string)
        .collect())
}

#[tauri::command]
fn git_diff_files(path: String, base: String, head: String) -> Result<Vec<String>, String> {
    let project_path = PathBuf::from(&path);
    if !project_path.is_dir() {
        return Err("Project path must be a directory".to_string());
    }
    let range = format!("{}..{}", base, head);
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&project_path)
        .args(["diff", "--name-only", &range])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|file| file.ends_with(".py"))
        .map(str::to_string)
        .collect())
}

#[tauri::command]
fn detect_editors() -> Vec<String> {
    let candidates = ["pycharm", "pycharm-community", "pycharm.sh", "code"];
    candidates
        .iter()
        .filter(|command| {
            std::process::Command::new("which")
                .arg(command)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        })
        .map(|command| (*command).to_string())
        .collect()
}

fn collect_python_files(root: &PathBuf) -> HashMap<PathBuf, Option<SystemTime>> {
    let mut files = HashMap::new();
    collect_python_files_recursive(root, &mut files);
    files
}

fn collect_python_files_recursive(
    root: &PathBuf,
    files: &mut HashMap<PathBuf, Option<SystemTime>>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            n.starts_with('.')
                || n == "__pycache__"
                || n == "venv"
                || n == ".venv"
                || n == "node_modules"
                || n == "target"
        }) {
            continue;
        }
        if path.is_dir() {
            collect_python_files_recursive(&path, files);
        } else if path.extension().and_then(|e| e.to_str()) == Some("py") {
            files.insert(
                path.clone(),
                fs::metadata(&path).ok().and_then(|m| m.modified().ok()),
            );
        }
    }
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
            let url = format!(
                "jetbrains://pycharm/navigate/reference?path={}:{}",
                file_path, line_num
            );
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
                    eprintln!(
                        "Warning: Could not launch PyCharm CLI automatically. URL: {}",
                        url
                    );
                }
            }
        }
        _ => return Err(format!("Unsupported editor: {}", editor)),
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(WatchState {
            stop_sender: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            analyze_project,
            watch_project,
            stop_watching,
            git_changed_files,
            git_diff_files,
            detect_editors,
            open_in_editor
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
