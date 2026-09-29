#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[tauri::command]
async fn manual_request(request: serde_json::Value) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || manual_core::request(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn choose_project() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("マニュアルを管理するプロジェクトを選択")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn choose_image() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("登録するPNGを選択")
            .add_filter("PNG画像", &["png"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_output(root: String) -> Result<(), String> {
    let root = PathBuf::from(root);
    let output =
        manual_core::config::project_path(&root, &manual_core::config::read_config(&root).output)?;
    if !output.is_dir() {
        return Err("先に下書きビルドを実行してください。".into());
    }
    open::that(output).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_editor(app: tauri::AppHandle, root: String, page: String) -> Result<(), String> {
    use tauri::Manager;
    manual_core::editor::read(&PathBuf::from(&root), &page)?;
    let label = format!(
        "editor-{:x}",
        Sha256::digest(format!("{root}\n{page}").as_bytes())
    );
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(|error| error.to_string());
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("editor", "1")
        .append_pair("root", &root)
        .append_pair("page", &page)
        .finish();
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("index.html?{query}").into()),
    )
    .title(format!("{page} — Manual Studio"))
    .inner_size(1250.0, 850.0)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            manual_request,
            choose_project,
            choose_image,
            open_editor,
            open_output
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Manual Studio");
}
