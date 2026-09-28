use regex::Regex;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::tempdir_in;

use super::author;
use super::config::{project_path, read_config};
use super::task::find_task;

#[derive(Deserialize)]
struct Scenario {
    version: u32,
    base_url: String,
    steps: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct RunResult {
    captured: Vec<String>,
}

pub fn run(root: &Path, input: &str) -> Result<String, String> {
    let input_path = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        root.join(input)
    };
    let raw = fs::read_to_string(&input_path)
        .map_err(|error| format!("Failed to read scenario {}: {error}", input_path.display()))?;
    let scenario: Scenario = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid scenario JSON: {error}"))?;
    if scenario.version != 1 || scenario.base_url.trim().is_empty() || scenario.steps.is_empty() {
        return Err("Scenario requires version 1, base_url, and at least one step".into());
    }
    let docs = project_path(root, &read_config(root).docs)?;
    let id_pattern = Regex::new(r"^[a-z][a-z0-9-]*$").unwrap();
    for (index, step) in scenario.steps.iter().enumerate() {
        let object = step
            .as_object()
            .ok_or_else(|| format!("Scenario step {} must be an object", index + 1))?;
        if object.len() != 1 {
            return Err(format!("Scenario step {} must contain one action", index + 1));
        }
        if let Some(screenshot) = object.get("screenshot") {
            let task_id = screenshot
                .get("task")
                .and_then(|value| value.as_str())
                .ok_or_else(|| format!("Scenario screenshot {} needs a task ID", index + 1))?;
            if !id_pattern.is_match(task_id) {
                return Err(format!("Invalid scenario screenshot task ID: {task_id}"));
            }
            let task = find_task(&docs, task_id)?;
            if task.kind != "screenshot" {
                return Err(format!("Scenario task is not a screenshot: {task_id}"));
            }
        } else if !["goto", "click", "fill", "expect_visible"].iter().any(|key| object.contains_key(*key)) {
            return Err(format!("Unsupported scenario step {}", index + 1));
        }
    }

    let temporary = tempdir_in(root).map_err(|error| error.to_string())?;
    let script = temporary.path().join("scenario_runner.mjs");
    let captured_dir = temporary.path().join("captured");
    fs::write(&script, include_str!("scenario_runner.mjs")).map_err(|error| error.to_string())?;
    let result = Command::new("node")
        .arg(&script)
        .arg(&input_path)
        .arg(&captured_dir)
        .current_dir(root)
        .output()
        .map_err(|error| format!("Failed to start Node.js scenario runner: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "Scenario failed: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    let output = String::from_utf8(result.stdout).map_err(|error| error.to_string())?;
    let completed: RunResult = serde_json::from_str(&output)
        .map_err(|error| format!("Invalid scenario runner output: {error}"))?;
    for task_id in &completed.captured {
        author::record_screenshot(root, task_id, &captured_dir.join(format!("{task_id}.png")))?;
    }
    Ok(output)
}
