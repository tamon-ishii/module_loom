use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub fn utc_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn source_hash(kind: &str, prompt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{kind}\n{prompt}").as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub kind: String,
    pub page: String,
    pub prompt: String,
    pub source_sha256: String,
    pub status: String, // "missing", "current", "approved", "stale"
}

pub fn task_regex() -> Regex {
    Regex::new(
        r"(?s)<!-- ai:task id=(?P<id>[a-z][a-z0-9-]*) kind=(?P<kind>text|screenshot|diagram)\n(?P<prompt>.*?)\n-->",
    ).expect("valid task regex")
}

pub fn generated_regex() -> Regex {
    Regex::new(
        r"(?s)<!-- ai:generated id=(?P<id>[a-z][a-z0-9-]*) kind=(?P<kind>text|screenshot|diagram)(?: created-at=(?P<created>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))?(?: source-sha256=(?P<hash>[a-f0-9]{64}))?(?: approved-at=(?P<approved>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))? -->\n(?P<body>.*?)\n<!-- /ai:generated -->",
    ).expect("valid generated regex")
}

pub fn answer_regex() -> Regex {
    Regex::new(
        r"(?s)\A<!-- ai:answer id=(?P<id>[a-z][a-z0-9-]*) source-sha256=(?P<hash>[a-f0-9]{64}) created-at=(?P<created>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?: approved-at=(?P<approved>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))? -->\n(?P<body>.*)\z",
    ).expect("valid answer regex")
}

pub fn collect_markdown_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() && entry.path().extension().map_or(false, |ext| ext == "md") {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    files
}

pub fn tasks(templates: &Path) -> Result<Vec<Task>, String> {
    if !templates.is_dir() {
        return Err(format!("Template directory is missing: {}", templates.display()));
    }
    let mut found = Vec::new();
    let mut ids = HashSet::new();
    let t_re = task_regex();
    let g_re = generated_regex();

    for page in collect_markdown_files(templates) {
        let content = fs::read_to_string(&page).map_err(|e| e.to_string())?;
        let page_rel = page.strip_prefix(templates).unwrap_or(&page).to_string_lossy().replace('\\', "/");

        // 1. 未生成の指示タグ (ai:task)
        for cap in t_re.captures_iter(&content) {
            let task_id = cap.name("id").unwrap().as_str().to_string();
            if ids.contains(&task_id) {
                return Err(format!("Duplicate task ID: {task_id}"));
            }
            ids.insert(task_id.clone());
            let prompt = cap.name("prompt").unwrap().as_str().trim().to_string();
            if prompt.is_empty() {
                return Err(format!("Empty instruction: {task_id}"));
            }
            let kind = cap.name("kind").unwrap().as_str().to_string();
            let hash = source_hash(&kind, &prompt);
            found.push(Task {
                id: task_id,
                kind,
                page: page_rel.clone(),
                prompt,
                source_sha256: hash,
                status: "missing".to_string(),
            });
        }

        // 2. AI生成済みのタグ (ai:generated)
        for cap in g_re.captures_iter(&content) {
            let task_id = cap.name("id").unwrap().as_str().to_string();
            if ids.contains(&task_id) {
                return Err(format!("Duplicate task ID: {task_id}"));
            }
            ids.insert(task_id.clone());
            let kind = cap.name("kind").unwrap().as_str().to_string();
            let approved = cap.name("approved").is_some();
            let hash = cap.name("hash").map(|h| h.as_str().to_string()).unwrap_or_default();
            found.push(Task {
                id: task_id,
                kind: kind.clone(),
                page: page_rel.clone(),
                prompt: format!("AI生成コンテンツ ({kind})"),
                source_sha256: hash,
                status: if approved { "approved".to_string() } else { "current".to_string() },
            });
        }
    }
    Ok(found)
}

pub fn read_answer(path: &Path, task: &Task) -> Result<(String, String, Option<String>), String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let a_re = answer_regex();
    let cap = a_re.captures(&content).ok_or_else(|| format!("Invalid answer header: {}", path.display()))?;
    
    let id = cap.name("id").unwrap().as_str();
    if id != task.id {
        return Err(format!("Invalid answer header: {}", path.display()));
    }
    let hash = cap.name("hash").unwrap().as_str();
    if hash != task.source_sha256 {
        return Err(format!("Stale answer for {}; record it again after reviewing the instruction", task.id));
    }
    let body = cap.name("body").unwrap().as_str().trim();
    if body.is_empty() {
        return Err(format!("Empty answer: {}", path.display()));
    }
    let created = cap.name("created").unwrap().as_str().to_string();
    let approved = cap.name("approved").map(|a| a.as_str().to_string());
    Ok((created, body.to_string(), approved))
}

pub fn scan_entries(templates: &Path, generated: &Path) -> Vec<Task> {
    if !templates.is_dir() {
        return Vec::new();
    }
    let mut entries = match tasks(templates) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    for task in &mut entries {
        if task.status == "approved" || task.status == "current" {
            continue;
        }
        let answer_path = generated.join("answers").join(format!("{}.md", task.id));
        if !answer_path.exists() {
            task.status = "missing".to_string();
        } else {
            match read_answer(&answer_path, task) {
                Ok((_, _, approved)) => {
                    task.status = if approved.is_some() { "approved".to_string() } else { "current".to_string() };
                }
                Err(_) => {
                    task.status = "stale".to_string();
                }
            }
        }
    }
    entries
}

pub fn find_task(templates: &Path, task_id: &str) -> Result<Task, String> {
    let all = tasks(templates)?;
    all.into_iter()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("Unknown task ID: {task_id}"))
}

pub fn update_task_in_docs(
    templates: &Path,
    task: &Task,
    body: &str,
    approved: Option<&str>,
) -> Result<(), String> {
    let page_path = templates.join(&task.page);
    if !page_path.is_file() {
        return Err(format!("Page file not found: {}", page_path.display()));
    }
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let task_id = &task.id;
    let kind = &task.kind;
    let created = utc_now();
    let hash_val = &task.source_sha256;
    let approved_attr = approved.map(|a| format!(" approved-at={a}")).unwrap_or_default();
    let hash_attr = if !hash_val.is_empty() {
        format!(" source-sha256={hash_val}")
    } else {
        String::new()
    };

    let replacement = format!(
        "<!-- ai:generated id={task_id} kind={kind} created-at={created}{hash_attr}{approved_attr} -->\n{}\n<!-- /ai:generated -->",
        body.trim()
    );

    // 1. ai:task を置換
    let task_pattern = Regex::new(&format!(
        r"(?s)<!-- ai:task id={kind_id} kind={kind}\n.*?\n-->",
        kind_id = regex::escape(task_id),
        kind = regex::escape(kind),
    )).map_err(|e| e.to_string())?;

    if task_pattern.is_match(&content) {
        let new_content = task_pattern.replacen(&content, 1, &replacement);
        fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // 2. ai:generated を置換
    let gen_pattern = Regex::new(&format!(
        r"(?s)<!-- ai:generated id={kind_id} kind={kind}.*?-->\n.*?\n<!-- /ai:generated -->",
        kind_id = regex::escape(task_id),
        kind = regex::escape(kind),
    )).map_err(|e| e.to_string())?;

    if gen_pattern.is_match(&content) {
        let new_content = gen_pattern.replacen(&content, 1, &replacement);
        fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // 3. なければ末尾に追加
    let new_content = format!("{}\n\n{}\n", content.trim_end(), replacement);
    fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_answer(generated: &Path, task: &Task, body: &str) -> Result<(), String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("Answer body is empty".to_string());
    }
    let dest = generated.join("answers").join(format!("{}.md", task.id));
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let header = format!(
        "<!-- ai:answer id={} source-sha256={} created-at={} -->\n",
        task.id,
        task.source_sha256,
        utc_now(),
    );
    fs::write(&dest, format!("{header}{body}\n")).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn approve_task(templates: &Path, generated: &Path, task_id: &str) -> Result<(), String> {
    let task = find_task(templates, task_id)?;
    let page_path = templates.join(&task.page);
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let now = utc_now();

    let pattern = Regex::new(&format!(
        r"(?s)<!-- ai:generated id={escaped_id} kind={kind}(?P<attrs>.*?) -->\n(?P<body>.*?)\n<!-- /ai:generated -->",
        escaped_id = regex::escape(task_id),
        kind = regex::escape(&task.kind),
    )).map_err(|e| e.to_string())?;

    if let Some(cap) = pattern.captures(&content) {
        let mut attrs = cap.name("attrs").unwrap().as_str().to_string();
        if !attrs.contains("approved-at=") {
            attrs = format!("{attrs} approved-at={now}");
        } else {
            let re_attr = Regex::new(r"approved-at=\S+").unwrap();
            attrs = re_attr.replace(&attrs, format!("approved-at={now}").as_str()).to_string();
        }
        let body = cap.name("body").unwrap().as_str();
        let replacement = format!(
            "<!-- ai:generated id={task_id} kind={kind}{attrs} -->\n{body}\n<!-- /ai:generated -->",
            kind = task.kind,
        );
        let new_content = pattern.replacen(&content, 1, &replacement);
        fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
    }

    let answer_path = generated.join("answers").join(format!("{task_id}.md"));
    if answer_path.is_file() {
        if let Ok((created, body, _)) = read_answer(&answer_path, &task) {
            let new_ans = format!(
                "<!-- ai:answer id={task_id} source-sha256={} created-at={created} approved-at={now} -->\n{body}\n",
                task.source_sha256
            );
            let _ = fs::write(&answer_path, new_ans);
        }
    }

    Ok(())
}
