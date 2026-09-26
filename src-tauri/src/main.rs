// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ruff_fix;

use moduleloom_analyzer::model::AnalysisResult;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};

struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    cached_result: Mutex<Option<AnalysisResult>>,
}

#[tauri::command]
fn initial_project_path() -> Option<String> {
    std::env::var_os("MODULELOOM_INITIAL_PROJECT_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn preview_cycle_fix(
    path: String,
    source: String,
    line: usize,
    tool_id: String,
    state: State<'_, WatchState>,
    fix_state: State<'_, ruff_fix::FixState>,
) -> Result<ruff_fix::FixPreview, String> {
    let result = state
        .cached_result
        .lock()
        .map_err(|_| "解析結果を取得できません")?
        .clone()
        .ok_or("先に解析を実行してください")?;
    ruff_fix::preview(
        std::path::Path::new(&path),
        &result,
        &source,
        line,
        &tool_id,
        &fix_state,
    )
}

#[tauri::command]
fn list_fix_tools(path: String) -> Result<Vec<ruff_fix::FixToolInfo>, String> {
    ruff_fix::list_tools(std::path::Path::new(&path))
}

#[tauri::command]
fn apply_cycle_fix(
    state: State<'_, WatchState>,
    fix_state: State<'_, ruff_fix::FixState>,
) -> Result<String, String> {
    let file = ruff_fix::apply(&fix_state)?;
    *state
        .cached_result
        .lock()
        .map_err(|_| "解析キャッシュを更新できません")? = None;
    Ok(file)
}

#[tauri::command]
async fn analyze_project(
    path: String,
    changed_files: Option<Vec<PathBuf>>,
    quality: Option<bool>,
    app: AppHandle,
) -> Result<AnalysisResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analyze_project_blocking(path, changed_files, quality, app)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn analyze_project_blocking(
    path: String,
    changed_files: Option<Vec<PathBuf>>,
    quality: Option<bool>,
    app: AppHandle,
) -> Result<AnalysisResult, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    let state = app.state::<WatchState>();
    let mut cached = state
        .cached_result
        .lock()
        .map_err(|_| "Analysis cache is unavailable")?;
    let mut result = match (cached.as_ref(), changed_files.as_deref()) {
        (Some(previous), Some(changed)) if !changed.is_empty() && previous.root_path == p => {
            moduleloom_analyzer::analyze_directory_incremental(&p, previous, changed)
                .or_else(|_| moduleloom_analyzer::analyze_directory(&p))?
        }
        _ => moduleloom_analyzer::analyze_directory(&p)?,
    };
    if quality.unwrap_or(false) {
        let filename = if cfg!(windows) { "jscpd.exe" } else { "jscpd" };
        let bundled = app.path().resolve(format!("binaries/{filename}"), BaseDirectory::Resource);
        if let Some(path) = bundled.ok().filter(|path| path.is_file()) {
            moduleloom_analyzer::enrich_quality_with_jscpd(&mut result, &path);
        } else {
            moduleloom_analyzer::enrich_quality(&mut result);
        }
    }
    *cached = Some(result.clone());
    Ok(result)
}

#[tauri::command]
fn generate_mkdocs(
    path: String,
    output: String,
    lang: Option<String>,
    state: State<'_, WatchState>,
) -> Result<String, String> {
    let result = state
        .cached_result
        .lock()
        .map_err(|_| "解析結果を取得できません")?
        .clone()
        .ok_or("先に解析を実行してください")?;
    if result.root_path != PathBuf::from(&path) {
        return Err("表示中のプロジェクトと解析結果が一致しません".into());
    }
    moduleloom_analyzer::mkdocs::generate_with_lang(
        &result,
        std::path::Path::new(&output),
        lang.as_deref().unwrap_or("auto"),
    )?;
    Ok(output)
}

#[tauri::command]
fn watch_project(path: String, app: AppHandle, state: State<'_, WatchState>) -> Result<(), String> {
    let project_path = PathBuf::from(&path);
    if !project_path.is_dir() {
        return Err("Project path must be a directory".to_string());
    }

    let root = project_path.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if !matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Remove(_)
            ) {
                return;
            }
            if matches!(
                event.kind,
                notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
            ) {
                return;
            }
            let structural = matches!(
                event.kind,
                notify::EventKind::Create(notify::event::CreateKind::Folder)
                    | notify::EventKind::Remove(notify::event::RemoveKind::Folder)
                    | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            );
            let removed_or_renamed = matches!(
                event.kind,
                notify::EventKind::Remove(_)
                    | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            );
            let paths: Vec<PathBuf> = event
                .paths
                .into_iter()
                .filter(|path| should_refresh(path, &root, structural, removed_or_renamed))
                .collect();
            if !paths.is_empty() {
                let _ = app.emit("project-changed", paths);
            }
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&project_path, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    let mut current = state
        .watcher
        .lock()
        .map_err(|_| "Watcher state is unavailable")?;
    *current = Some(watcher);
    Ok(())
}

#[tauri::command]
fn stop_watching(state: State<'_, WatchState>) -> Result<(), String> {
    let mut watcher = state
        .watcher
        .lock()
        .map_err(|_| "Watcher state is unavailable".to_string())?;
    watcher.take();
    Ok(())
}

fn should_refresh(
    path: &PathBuf,
    root: &PathBuf,
    structural: bool,
    removed_or_renamed: bool,
) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if relative.as_os_str().is_empty() {
        return false;
    }
    if relative.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name.starts_with('.')
            || matches!(
                name.as_ref(),
                "__pycache__" | "venv" | ".venv" | "node_modules" | "target"
            )
    }) {
        return false;
    }
    path.extension().and_then(|ext| ext.to_str()) == Some("py")
        || relative == std::path::Path::new("moduleloom.toml")
        || (structural && (path.is_dir() || path.extension().is_none() || removed_or_renamed))
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

#[tauri::command]
fn open_in_editor(editor: String, file_path: String, line: Option<usize>) -> Result<(), String> {
    let line_num = line.unwrap_or(1).max(1);
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
            let file = std::fs::canonicalize(&file_path)
                .map_err(|error| format!("ファイルを開けません: {file_path}: {error}"))?;
            let mut commands: Vec<PathBuf> = [
                "pycharm",
                "pycharm.sh",
                "pycharm-community",
                "pycharm64.exe",
            ]
            .into_iter()
            .map(PathBuf::from)
            .collect();
            if let Some(home) = std::env::var_os("HOME") {
                commands.push(
                    PathBuf::from(home).join(".local/share/JetBrains/Toolbox/scripts/pycharm"),
                );
            }
            let mut launch_error = None;
            for command in commands {
                match std::process::Command::new(&command)
                    .arg("--line")
                    .arg(line_num.to_string())
                    .arg(&file)
                    .spawn()
                {
                    Ok(mut child) => {
                        std::thread::spawn(move || {
                            let _ = child.wait();
                        });
                        return Ok(());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => launch_error = Some(error),
                }
            }
            if let Some(error) = launch_error {
                return Err(format!("PyCharm を起動できません: {error}"));
            }
            return Err("PyCharm のコマンドライン起動スクリプトが見つかりません。Toolbox でシェルスクリプトを有効にしてください".into());
        }
        _ => return Err(format!("Unsupported editor: {}", editor)),
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(WatchState {
            watcher: Mutex::new(None),
            cached_result: Mutex::new(None),
        })
        .manage(ruff_fix::FixState::default())
        .invoke_handler(tauri::generate_handler![
            initial_project_path,
            analyze_project,
            generate_mkdocs,
            list_fix_tools,
            preview_cycle_fix,
            apply_cycle_fix,
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
