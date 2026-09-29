use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use super::config::{project_path, read_config};
use super::{author, scenario, task, window_capture};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureSource {
    Window { title: String, inset: u32 },
    Scenario { input: String },
}

pub fn read(root: &Path) -> Result<BTreeMap<String, CaptureSource>, String> {
    let path = project_path(root, "manual/capture_sources.json")?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str(&fs::read_to_string(&path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid saved capture sources: {error}"))
}

fn save(root: &Path, id: &str, source: CaptureSource) -> Result<(), String> {
    let mut sources = read(root)?;
    sources.insert(id.to_string(), source);
    let path = project_path(root, "manual/capture_sources.json")?;
    let parent = path.parent().ok_or("Invalid capture source path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, &sources).map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn screenshot_task(root: &Path, id: &str) -> Result<(), String> {
    let docs = project_path(root, &read_config(root).docs)?;
    if task::find_task(&docs, id)?.kind != "screenshot" {
        return Err(format!("Task is not a screenshot: {id}"));
    }
    Ok(())
}

pub fn capture(root: &Path, id: &str, window_id: &str, inset: u32) -> Result<String, String> {
    screenshot_task(root, id)?;
    if inset > 64 {
        return Err("Inset cannot exceed 64 pixels".into());
    }
    // Validate the saved file before capturing so a corrupt configuration is preserved.
    read(root)?;
    let docs = project_path(root, &read_config(root).docs)?;
    let temporary = tempfile::tempdir_in(root).map_err(|error| error.to_string())?;
    let image = super::config::project_path(temporary.path(), &format!("{id}.png"))?;
    let window = window_capture::capture_window(window_id, inset, &image)?;
    author::record_screenshot(root, id, &image)?;
    save(
        root,
        id,
        CaptureSource::Window {
            title: window.title.clone(),
            inset,
        },
    )?;
    serde_json::to_string(&serde_json::json!({"window": window, "image": docs.join("assets").join(format!("{id}.png"))}))
        .map_err(|error| error.to_string())
}

fn resolve_window<'a>(
    source: &CaptureSource,
    windows: &'a [window_capture::WindowInfo],
) -> Result<&'a window_capture::WindowInfo, String> {
    let CaptureSource::Window { title, .. } = source else {
        return Err("Capture source is not a window".into());
    };
    if window_capture::is_wayland_session() {
        return windows
            .iter()
            .find(|window| window.id == "portal")
            .ok_or_else(|| "Open the system screenshot chooser again".into());
    }
    let matches: Vec<_> = windows
        .iter()
        .filter(|window| window.title == *title)
        .collect();
    match matches.as_slice() {
        [window] => Ok(window),
        [] => Err(format!("保存した撮影元「{title}」が見つかりません。対象画面を開くか、「撮影元を変更」で選び直してください。")),
        _ => Err(format!("撮影元「{title}」が複数あります。「撮影元を変更」で対象を選び直してください。")),
    }
}

pub fn recapture(root: &Path, id: &str) -> Result<String, String> {
    screenshot_task(root, id)?;
    let source = read(root)?
        .remove(id)
        .ok_or("先に撮影元を選んで撮影してください。")?;
    match source {
        CaptureSource::Window { inset, .. } => {
            let windows = window_capture::list_windows()?;
            let window = resolve_window(&source, &windows)?;
            capture(root, id, &window.id, inset)
        }
        CaptureSource::Scenario { input } => {
            scenario::validate_capture_task(root, &input, id)?;
            scenario::run(root, &input)
        }
    }
}

pub fn save_scenario(root: &Path, id: &str, input: &str) -> Result<String, String> {
    screenshot_task(root, id)?;
    scenario::validate_capture_task(root, input, id)?;
    let source = CaptureSource::Scenario {
        input: input.to_string(),
    };
    save(root, id, source.clone())?;
    serde_json::to_string(&source).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_windows_survive_restart_without_reusing_native_ids() {
        let root = tempfile::tempdir().unwrap();
        save(
            root.path(),
            "shot",
            CaptureSource::Window {
                title: "Settings".into(),
                inset: 8,
            },
        )
        .unwrap();
        let sources = read(root.path()).unwrap();
        let windows = vec![window_capture::WindowInfo {
            id: "new-id".into(),
            title: "Settings".into(),
            x: 0,
            y: 0,
            width: 100,
            height: 80,
        }];
        assert_eq!(
            resolve_window(&sources["shot"], &windows).unwrap().id,
            "new-id"
        );
        let duplicate = vec![windows[0].clone(), windows[0].clone()];
        assert!(resolve_window(&sources["shot"], &duplicate).is_err());
        let other = vec![window_capture::WindowInfo {
            title: "Settings for another app".into(),
            ..windows[0].clone()
        }];
        assert!(resolve_window(&sources["shot"], &other).is_err());
    }

    #[test]
    fn scenario_sources_require_the_requested_screenshot_and_preserve_other_sources() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/index.md"), "<!-- ai:task id=shot kind=screenshot\nCapture\n-->\n<!-- ai:task id=other kind=screenshot\nOther\n-->\n").unwrap();
        scenario::save(root.path(), "manual/scenarios/test.json", r#"{"version":1,"platform":"desktop","window":"Settings","steps":[{"screenshot":{"task":"shot"}}]}"#).unwrap();
        save_scenario(root.path(), "shot", "manual/scenarios/test.json").unwrap();
        let original = fs::read(root.path().join("manual/capture_sources.json")).unwrap();
        assert!(save_scenario(root.path(), "other", "manual/scenarios/test.json").is_err());
        assert_eq!(
            original,
            fs::read(root.path().join("manual/capture_sources.json")).unwrap()
        );
        save(
            root.path(),
            "other",
            CaptureSource::Window {
                title: "Other".into(),
                inset: 0,
            },
        )
        .unwrap();
        assert_eq!(read(root.path()).unwrap().len(), 2);
        fs::write(root.path().join("manual/capture_sources.json"), "broken").unwrap();
        assert!(save_scenario(root.path(), "shot", "manual/scenarios/test.json").is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("manual/capture_sources.json")).unwrap(),
            "broken"
        );
    }
}
