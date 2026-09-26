use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tempfile::tempdir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

pub fn which_binary(name: &str) -> Option<PathBuf> {
    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            let full_path = dir.join(name);
            if full_path.is_file() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = fs::metadata(&full_path) {
                        if meta.permissions().mode() & 0o111 != 0 {
                            return Some(full_path);
                        }
                    }
                }
                #[cfg(not(unix))]
                return Some(full_path);
            }
            #[cfg(windows)]
            {
                for ext in &["exe", "cmd", "bat"] {
                    let with_ext = dir.join(format!("{name}.{ext}"));
                    if with_ext.is_file() {
                        return Some(with_ext);
                    }
                }
            }
        }
    }
    None
}

pub fn get_agents() -> Vec<AgentInfo> {
    let list = [
        ("codex", "Codex"),
        ("claude", "Claude Code"),
        ("grok", "Grok Build"),
        ("agy", "Agy"),
    ];
    list.into_iter()
        .map(|(id, label)| AgentInfo {
            id: id.to_string(),
            label: label.to_string(),
            available: which_binary(id).is_some(),
        })
        .collect()
}

pub fn agent_json(
    root: &Path,
    prompt: &str,
    schema: &Value,
    agent: &str,
    model: &str,
) -> Result<Value, String> {
    let tmp = tempdir().map_err(|e| e.to_string())?;
    let schema_path = tmp.path().join("schema.json");
    let answer_path = tmp.path().join("answer.json");
    let schema_str = serde_json::to_string(schema).map_err(|e| e.to_string())?;
    fs::write(&schema_path, &schema_str).map_err(|e| e.to_string())?;

    let mut cmd_args: Vec<String> = Vec::new();
    let binary_name = match agent {
        "codex" => {
            cmd_args.extend([
                "exec".into(),
                "--ephemeral".into(),
                "--skip-git-repo-check".into(),
                "--sandbox".into(),
                "read-only".into(),
                "--cd".into(),
                root.to_string_lossy().into_owned(),
                "--output-schema".into(),
                schema_path.to_string_lossy().into_owned(),
                "--output-last-message".into(),
                answer_path.to_string_lossy().into_owned(),
                prompt.to_string(),
            ]);
            "codex"
        }
        "claude" => {
            cmd_args.extend([
                "-p".into(),
                "--output-format".into(),
                "json".into(),
                "--json-schema".into(),
                schema_str.clone(),
                "--restricted".into(),
                "--no-session-persistence".into(),
                prompt.to_string(),
            ]);
            "claude"
        }
        "grok" => {
            let grok_prompt = format!(
                "{prompt}\nReturn a JSON object only, matching this schema: {schema_str}"
            );
            cmd_args.extend([
                "--no-auto-update".into(),
                "-p".into(),
                grok_prompt,
                "--cwd".into(),
                root.to_string_lossy().into_owned(),
                "--output-format".into(),
                "json".into(),
                "--tools".into(),
                "read_file,grep,list_dir".into(),
                "--no-subagents".into(),
            ]);
            "grok"
        }
        "agy" => {
            cmd_args.extend([
                "-p".into(),
                prompt.to_string(),
                "--output-format".into(),
                "json".into(),
                "--json-schema".into(),
                schema_str.clone(),
                "--sandbox".into(),
            ]);
            "agy"
        }
        _ => return Err(format!("Unsupported AI agent: {agent}")),
    };

    if !model.is_empty() {
        cmd_args.insert(0, model.to_string());
        cmd_args.insert(0, "--model".to_string());
    }

    if which_binary(binary_name).is_none() {
        return Err(format!("AI CLI is unavailable: {binary_name}"));
    }

    let output = Command::new(binary_name)
        .args(&cmd_args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("Failed to run {binary_name}: {e}"))?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr);
        let out_text = String::from_utf8_lossy(&output.stdout);
        let msg = if !err_text.trim().is_empty() {
            err_text.trim()
        } else {
            out_text.trim()
        };
        let tail = if msg.len() > 2000 {
            &msg[msg.len() - 2000..]
        } else {
            msg
        };
        return Err(format!("{agent} failed: {tail}"));
    }

    if agent == "codex" {
        let answer_content = fs::read_to_string(&answer_path)
            .map_err(|e| format!("Failed to read codex answer: {e}"))?;
        return serde_json::from_str(&answer_content).map_err(|e| e.to_string());
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse {agent} JSON: {e}\nOutput was: {stdout_str}"))?;

    if agent == "grok" {
        if let Some(text) = parsed.get("text").and_then(|t| t.as_str()) {
            return serde_json::from_str(text).map_err(|e| e.to_string());
        }
        return Ok(parsed);
    }

    if agent == "agy" {
        if let Some(status) = parsed.get("status").and_then(|s| s.as_str()) {
            if status != "SUCCESS" {
                let err = parsed.get("error").and_then(|e| e.as_str()).unwrap_or("Agy failed");
                return Err(err.to_string());
            }
        }
        if let Some(structured) = parsed.get("structured_output") {
            if structured.is_object() {
                return Ok(structured.clone());
            }
        }
        if let Some(resp) = parsed.get("response").and_then(|r| r.as_str()) {
            return serde_json::from_str(resp).map_err(|e| e.to_string());
        }
        return Ok(parsed);
    }

    if let Some(structured) = parsed.get("structured_output") {
        if structured.is_object() {
            return Ok(structured.clone());
        }
    }
    if let Some(res) = parsed.get("result").and_then(|r| r.as_str()) {
        return serde_json::from_str(res).map_err(|e| e.to_string());
    }

    Ok(parsed)
}

pub fn get_models(root: &Path, agent: &str) -> Result<Value, String> {
    if agent == "claude" {
        return Ok(json!({
            "models": [],
            "message": "Claude Code CLI はモデル一覧コマンドを提供していません。モデルIDを入力するか既定モデルを使ってください"
        }));
    }

    let command_name = match agent {
        "agy" => "agy",
        "grok" => "grok",
        "codex" => "codex",
        _ => return Err(format!("AI CLI is unavailable: {agent}")),
    };

    if which_binary(command_name).is_none() {
        return Err(format!("AI CLI is unavailable: {command_name}"));
    }

    let mut found = Vec::new();

    if agent == "codex" {
        let mut child = Command::new("codex")
            .arg("app-server")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;

        let mut stdin = child.stdin.take().ok_or("Failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
        let mut reader = BufReader::new(stdout);

        let messages = [
            json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "moduleloom", "version": "1.0.6"}, "capabilities": {}}}),
            json!({"method": "initialized", "params": {}}),
            json!({"id": 2, "method": "model/list", "params": {"limit": 100}}),
        ];

        for msg in &messages {
            let line = serde_json::to_string(msg).unwrap();
            writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
        }
        let _ = stdin.flush();

        let mut line_buf = String::new();
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            line_buf.clear();
            if reader.read_line(&mut line_buf).unwrap_or(0) == 0 {
                break;
            }
            if let Ok(item) = serde_json::from_str::<Value>(&line_buf) {
                if item.get("id").and_then(|id| id.as_i64()) == Some(2) {
                    if let Some(err) = item.get("error") {
                        let _ = child.kill();
                        return Err(err.to_string());
                    }
                    if let Some(result) = item.get("result").and_then(|r| r.as_object()) {
                        if let Some(data) = result.get("data").and_then(|d| d.as_array()) {
                            for entry in data {
                                if !entry.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false) {
                                    if let Some(model_id) = entry.get("model").and_then(|m| m.as_str()) {
                                        let label = entry
                                            .get("displayName")
                                            .and_then(|d| d.as_str())
                                            .unwrap_or(model_id);
                                        found.push(json!({
                                            "id": model_id,
                                            "label": label
                                        }));
                                    }
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    } else {
        let output = Command::new(command_name)
            .arg("models")
            .current_dir(root)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(err.trim().to_string());
        }

        let out = String::from_utf8_lossy(&output.stdout);
        let re = regex::Regex::new(r"^\s*([a-z][a-zA-Z0-9._-]*)\s+(.+)$").unwrap();
        for line in out.lines() {
            if let Some(cap) = re.captures(line) {
                let id = cap.get(1).unwrap().as_str();
                let label = cap.get(2).unwrap().as_str().trim();
                found.push(json!({
                    "id": id,
                    "label": label
                }));
            }
        }
    }

    Ok(json!({
        "models": found,
        "message": ""
    }))
}
