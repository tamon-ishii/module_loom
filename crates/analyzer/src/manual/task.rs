use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::config::{read_config, ManualConfig};

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

pub fn get_code_block_ranges(content: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut in_fence = false;
    let mut fence_char = ' ';
    let mut fence_len = 0;
    let mut fence_start = 0;

    let mut offset = 0;
    for line in content.split_inclusive('\n') {
        let line_len = line.len();
        let line_end = offset + line_len;
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();

        if indent <= 3 {
            if !in_fence {
                if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                    let ch = trimmed.chars().next().unwrap();
                    let len = trimmed.chars().take_while(|&c| c == ch).count();
                    in_fence = true;
                    fence_char = ch;
                    fence_len = len;
                    fence_start = offset;
                }
            } else {
                let ch = fence_char;
                let count = trimmed.chars().take_while(|&c| c == ch).count();
                let rest = &trimmed[count..];
                if count >= fence_len && rest.trim().is_empty() {
                    ranges.push(fence_start..line_end);
                    in_fence = false;
                }
            }
        }
        offset = line_end;
    }
    if in_fence {
        ranges.push(fence_start..content.len());
    }
    ranges
}

pub fn is_inside_ranges(range: &std::ops::Range<usize>, ranges: &[std::ops::Range<usize>]) -> bool {
    ranges.iter().any(|r| (range.start >= r.start && range.end <= r.end) || (range.start < r.end && range.end > r.start))
}

pub fn generate_auto_id(
    kind: &str,
    page_rel: &str,
    prompt: &str,
    existing_ids: &HashSet<String>,
) -> String {
    let clean_stem: String = Path::new(page_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("task")
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let clean_stem = clean_stem.trim_matches('-');
    let stem = if clean_stem.is_empty() { "task" } else { clean_stem };

    let hash = source_hash(kind, prompt);
    let short_hash = if hash.len() >= 6 { &hash[..6] } else { &hash };

    let base = format!("{kind}-{stem}-{short_hash}");
    if !existing_ids.contains(&base) {
        return base;
    }

    let mut counter = 1;
    loop {
        let candidate = format!("{base}-{counter}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageTag {
    Task {
        range: std::ops::Range<usize>,
        task: Task,
    },
    Generated {
        range: std::ops::Range<usize>,
        task: Task,
        body: String,
    },
}

pub fn task_regex() -> Regex {
    Regex::new(
        r"(?s)<!--\s*ai:task(?P<attrs>[^\r\n]*)\r?\n(?P<prompt>.*?)\r?\n-->",
    ).expect("valid task regex")
}

pub fn generated_regex() -> Regex {
    Regex::new(
        r"(?s)<!--\s*ai:generated(?P<attrs>[^>]*)-->\r?\n(?P<body>.*?)\r?\n<!--\s*/ai:generated\s*-->",
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

pub fn collect_target_markdown_files(root: &Path, config: &ManualConfig) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    let mut visited_paths = HashSet::new();
    let templates = root.join(&config.docs);

    for target in &config.targets {
        let trimmed = target.trim();
        if trimmed.is_empty() {
            continue;
        }
        let target_path = root.join(trimmed);
        if target_path.is_file() {
            if target_path.extension().map_or(false, |ext| ext == "md") {
                let canon = target_path.canonicalize().unwrap_or_else(|_| target_path.clone());
                if visited_paths.insert(canon) {
                    let rel = trimmed.replace('\\', "/");
                    files.push((rel, target_path));
                }
            }
        } else if target_path.is_dir() {
            let is_docs_dir = trimmed == config.docs || target_path == templates;
            for entry in WalkDir::new(&target_path).into_iter().filter_map(|e| e.ok()) {
                if entry.file_type().is_file() && entry.path().extension().map_or(false, |ext| ext == "md") {
                    let path = entry.path().to_path_buf();
                    let canon = path.canonicalize().unwrap_or_else(|_| path.clone());
                    if visited_paths.insert(canon) {
                        let rel = if is_docs_dir {
                            path.strip_prefix(&templates)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .replace('\\', "/")
                        } else {
                            path.strip_prefix(root)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .replace('\\', "/")
                        };
                        files.push((rel, path));
                    }
                }
            }
        }
    }

    if templates.is_dir() && !config.targets.iter().any(|t| t == &config.docs) {
        for entry in WalkDir::new(&templates).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() && entry.path().extension().map_or(false, |ext| ext == "md") {
                let path = entry.path().to_path_buf();
                let canon = path.canonicalize().unwrap_or_else(|_| path.clone());
                if visited_paths.insert(canon) {
                    let rel = path
                        .strip_prefix(&templates)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    files.push((rel, path));
                }
            }
        }
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

fn extract_attr<'a>(re: &Regex, s: &'a str) -> Option<&'a str> {
    re.captures(s).and_then(|cap| {
        cap.get(1).or_else(|| cap.get(2)).or_else(|| cap.get(3)).map(|m| m.as_str())
    })
}

pub fn parse_page_tags(
    page_rel: &str,
    content: &str,
    existing_ids: &mut HashSet<String>,
) -> Result<Vec<PageTag>, String> {
    let code_blocks = get_code_block_ranges(content);
    let t_re = task_regex();
    let g_re = generated_regex();

    let id_re = Regex::new(r#"(?:^|\s)id=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let kind_re = Regex::new(r#"(?:^|\s)kind=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let source_hash_re = Regex::new(r#"\bsource-sha256=([a-f0-9]{64})"#).unwrap();
    let approved_re = Regex::new(r#"\bapproved-at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"#).unwrap();
    let valid_id_re = Regex::new(r#"^[a-z][a-z0-9-]*$"#).unwrap();

    struct RawTask {
        range: std::ops::Range<usize>,
        attrs: String,
        prompt: String,
    }

    struct RawGenerated {
        range: std::ops::Range<usize>,
        attrs: String,
        body: String,
    }

    let mut raw_tasks = Vec::new();
    for cap in t_re.captures_iter(content) {
        let m = cap.get(0).unwrap();
        let range = m.start()..m.end();
        if is_inside_ranges(&range, &code_blocks) {
            continue;
        }
        let attrs = cap.name("attrs").map(|a| a.as_str()).unwrap_or("").to_string();
        let prompt = cap.name("prompt").unwrap().as_str().trim().to_string();
        if prompt.is_empty() {
            return Err(format!("Empty instruction in page: {page_rel}"));
        }
        raw_tasks.push(RawTask { range, attrs, prompt });
    }

    let mut raw_gens = Vec::new();
    for cap in g_re.captures_iter(content) {
        let m = cap.get(0).unwrap();
        let range = m.start()..m.end();
        if is_inside_ranges(&range, &code_blocks) {
            continue;
        }
        let attrs = cap.name("attrs").map(|a| a.as_str()).unwrap_or("").to_string();
        let body = cap.name("body").unwrap().as_str().to_string();
        raw_gens.push(RawGenerated { range, attrs, body });
    }

    // Pass 1: Validate and register all explicit IDs
    for t in &raw_tasks {
        if let Some(id_str) = extract_attr(&id_re, &t.attrs) {
            if !valid_id_re.is_match(id_str) {
                return Err(format!("Invalid task ID: '{id_str}' (must match ^[a-z][a-z0-9-]*$)"));
            }
            if existing_ids.contains(id_str) {
                return Err(format!("Duplicate task ID: {id_str}"));
            }
            existing_ids.insert(id_str.to_string());
        }
    }
    for g in &raw_gens {
        if let Some(id_str) = extract_attr(&id_re, &g.attrs) {
            if !valid_id_re.is_match(id_str) {
                return Err(format!("Invalid task ID: '{id_str}' (must match ^[a-z][a-z0-9-]*$)"));
            }
            if existing_ids.contains(id_str) {
                return Err(format!("Duplicate task ID: {id_str}"));
            }
            existing_ids.insert(id_str.to_string());
        } else {
            return Err(format!("Missing id in ai:generated in page: {page_rel}"));
        }
    }

    let mut tags = Vec::new();

    // Pass 2: Build Task objects, assigning auto IDs where omitted
    for t in raw_tasks {
        let kind = if let Some(k) = extract_attr(&kind_re, &t.attrs) {
            if k != "text" && k != "screenshot" && k != "diagram" {
                return Err(format!("Invalid task kind: '{k}' (must be text, screenshot, or diagram)"));
            }
            k.to_string()
        } else {
            "text".to_string()
        };

        let task_id = if let Some(id_str) = extract_attr(&id_re, &t.attrs) {
            id_str.to_string()
        } else {
            let auto = generate_auto_id(&kind, page_rel, &t.prompt, existing_ids);
            existing_ids.insert(auto.clone());
            auto
        };

        let hash = source_hash(&kind, &t.prompt);
        let task = Task {
            id: task_id,
            kind,
            page: page_rel.to_string(),
            prompt: t.prompt,
            source_sha256: hash,
            status: "missing".to_string(),
        };
        tags.push(PageTag::Task { range: t.range, task });
    }

    // Pass 3: Build Generated objects
    for g in raw_gens {
        let id_str = extract_attr(&id_re, &g.attrs).unwrap().to_string();
        let kind = if let Some(k) = extract_attr(&kind_re, &g.attrs) {
            k.to_string()
        } else {
            "text".to_string()
        };
        let approved = approved_re.is_match(&g.attrs);
        let hash = source_hash_re
            .captures(&g.attrs)
            .map(|c| c.get(1).unwrap().as_str().to_string())
            .unwrap_or_default();

        let task = Task {
            id: id_str,
            kind: kind.clone(),
            page: page_rel.to_string(),
            prompt: format!("AI生成コンテンツ ({kind})"),
            source_sha256: hash,
            status: if approved {
                "approved".to_string()
            } else {
                "current".to_string()
            },
        };
        tags.push(PageTag::Generated { range: g.range, task, body: g.body });
    }

    tags.sort_by_key(|t| match t {
        PageTag::Task { range, .. } => range.start,
        PageTag::Generated { range, .. } => range.start,
    });

    Ok(tags)
}

pub fn tasks_for_config(root: &Path, config: &ManualConfig) -> Result<Vec<Task>, String> {
    let mut found = Vec::new();
    let mut ids = HashSet::new();

    for (page_rel, page_path) in collect_target_markdown_files(root, config) {
        let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
        let tags = parse_page_tags(&page_rel, &content, &mut ids)?;
        for tag in tags {
            match tag {
                PageTag::Task { task, .. } => found.push(task),
                PageTag::Generated { task, .. } => found.push(task),
            }
        }
    }
    Ok(found)
}

pub fn tasks(templates: &Path) -> Result<Vec<Task>, String> {
    if let Some(parent) = templates.parent() {
        if parent.join("manual_setting.json").is_file() || parent.join("manual").join("config.json").is_file() {
            let config = read_config(parent);
            return tasks_for_config(parent, &config);
        }
    }
    if !templates.is_dir() {
        return Err(format!("Template directory is missing: {}", templates.display()));
    }
    let mut found = Vec::new();
    let mut ids = HashSet::new();

    for page in collect_markdown_files(templates) {
        let content = fs::read_to_string(&page).map_err(|e| e.to_string())?;
        let page_rel = page
            .strip_prefix(templates)
            .unwrap_or(&page)
            .to_string_lossy()
            .replace('\\', "/");

        let tags = parse_page_tags(&page_rel, &content, &mut ids)?;
        for tag in tags {
            match tag {
                PageTag::Task { task, .. } => found.push(task),
                PageTag::Generated { task, .. } => found.push(task),
            }
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
    let page_path = if templates.join(&task.page).is_file() {
        templates.join(&task.page)
    } else if let Some(parent) = templates.parent() {
        if parent.join(&task.page).is_file() {
            parent.join(&task.page)
        } else {
            templates.join(&task.page)
        }
    } else {
        templates.join(&task.page)
    };
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

    let page_rel = task.page.replace('\\', "/");
    let mut ids = HashSet::new();
    let tags = parse_page_tags(&page_rel, &content, &mut ids)?;

    if let Some(target_tag) = tags.iter().find(|t| match t {
        PageTag::Task { task: t, .. } => t.id == *task_id,
        PageTag::Generated { task: t, .. } => t.id == *task_id,
    }) {
        let range = match target_tag {
            PageTag::Task { range, .. } => range,
            PageTag::Generated { range, .. } => range,
        };
        let mut new_content = String::with_capacity(content.len() + replacement.len());
        new_content.push_str(&content[..range.start]);
        new_content.push_str(&replacement);
        new_content.push_str(&content[range.end..]);
        fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

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

    let page_rel = task.page.replace('\\', "/");
    let mut ids = HashSet::new();
    let tags = parse_page_tags(&page_rel, &content, &mut ids)?;

    if let Some(target_tag) = tags.iter().find(|t| match t {
        PageTag::Generated { task: t, .. } => t.id == task_id,
        _ => false,
    }) {
        if let PageTag::Generated { range, body, .. } = target_tag {
            let old_block = &content[range.start..range.end];
            let g_re = generated_regex();
            if let Some(cap) = g_re.captures(old_block) {
                let mut attrs = cap.name("attrs").map(|a| a.as_str()).unwrap_or("").to_string();
                if !attrs.contains("approved-at=") {
                    attrs = format!("{attrs} approved-at={now}");
                } else {
                    let re_attr = Regex::new(r"approved-at=\S+").unwrap();
                    attrs = re_attr.replace(&attrs, format!("approved-at={now}").as_str()).to_string();
                }
                let replacement = format!(
                    "<!-- ai:generated{attrs} -->\n{body}\n<!-- /ai:generated -->"
                );
                let mut new_content = String::with_capacity(content.len() + replacement.len());
                new_content.push_str(&content[..range.start]);
                new_content.push_str(&replacement);
                new_content.push_str(&content[range.end..]);
                fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
            }
        }
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
