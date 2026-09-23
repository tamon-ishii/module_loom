use crate::model::PackageDependency;
use std::fs;
use std::path::Path;

pub fn scan_package_dependencies(root: &Path) -> Vec<PackageDependency> {
    let mut result = Vec::new();
    let requirements = root.join("requirements.txt");
    if let Ok(content) = fs::read_to_string(&requirements) {
        for line in content.lines() {
            if let Some((name, version)) = parse_requirement(line) {
                result.push(PackageDependency {
                    name,
                    version,
                    source: "requirements.txt".into(),
                });
            }
        }
    }

    let pyproject = root.join("pyproject.toml");
    if let Ok(content) = fs::read_to_string(&pyproject) {
        let mut in_dependencies = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                in_dependencies = false;
            }
            if trimmed.contains("dependencies = [") || trimmed == "dependencies = [" {
                in_dependencies = true;
                continue;
            }
            if in_dependencies && trimmed.starts_with(']') {
                in_dependencies = false;
                continue;
            }
            if in_dependencies {
                let value = trimmed.trim_matches(',').trim().trim_matches('"');
                if let Some((name, version)) = parse_requirement(value) {
                    result.push(PackageDependency {
                        name,
                        version,
                        source: "pyproject.toml".into(),
                    });
                }
            }
        }
    }

    let uv_lock = root.join("uv.lock");
    if let Ok(content) = fs::read_to_string(&uv_lock) {
        let mut name: Option<String> = None;
        let mut version: Option<String> = None;
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(value) = quoted_value(trimmed, "name") {
                name = Some(value);
            }
            if let Some(value) = quoted_value(trimmed, "version") {
                version = Some(value);
            }
            if trimmed == "}" || trimmed == "[[package]]" {
                if let Some(package_name) = name.take() {
                    result.push(PackageDependency {
                        name: package_name,
                        version: version.take(),
                        source: "uv.lock".into(),
                    });
                }
            }
        }
        if let Some(package_name) = name {
            result.push(PackageDependency {
                name: package_name,
                version,
                source: "uv.lock".into(),
            });
        }
    }

    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    result.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name) && a.source == b.source);
    result
}

fn parse_requirement(value: &str) -> Option<(String, Option<String>)> {
    let value = value.split('#').next()?.trim();
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    let end = value
        .find(|c: char| matches!(c, '<' | '>' | '=' | '!' | '~' | ';' | '['))
        .unwrap_or(value.len());
    let name = value[..end].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let version = if end < value.len() {
        Some(value[end..].trim().trim_matches(';').to_string())
    } else {
        None
    };
    Some((name, version))
}

fn quoted_value(line: &str, key: &str) -> Option<String> {
    let prefix = format!("{} = \"", key);
    line.strip_prefix(&prefix)?
        .strip_suffix('"')
        .map(str::to_string)
}
