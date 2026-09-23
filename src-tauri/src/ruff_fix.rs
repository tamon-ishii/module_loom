use moduleloom_analyzer::model::{AnalysisResult, CycleSuggestionKind};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

#[derive(Default)]
pub struct FixState {
    pending: Mutex<Option<PendingFix>>,
}

struct PendingFix {
    root: PathBuf,
    file: PathBuf,
    source: String,
    target: String,
    line: usize,
    tool: FixTool,
    original: Vec<u8>,
    diff: String,
}

#[derive(Clone)]
struct FixTool {
    id: String,
    label: String,
    kinds: Vec<String>,
    command: PathBuf,
    preview_args: Vec<String>,
    apply_args: Vec<String>,
}

#[derive(Serialize)]
pub struct FixToolInfo {
    pub id: String,
    pub label: String,
    pub kinds: Vec<String>,
}

#[derive(Serialize)]
pub struct FixPreview {
    pub file: String,
    pub diff: String,
    pub tool: String,
}

pub fn list_tools(project: &Path) -> Result<Vec<FixToolInfo>, String> {
    let root = project.canonicalize().map_err(|error| error.to_string())?;
    Ok(available_tools(&root)?
        .into_iter()
        .map(|tool| FixToolInfo {
            id: tool.id,
            label: tool.label,
            kinds: tool.kinds,
        })
        .collect())
}

pub fn preview(
    project: &Path,
    result: &AnalysisResult,
    source: &str,
    line: usize,
    tool_id: &str,
    state: &FixState,
) -> Result<FixPreview, String> {
    *state
        .pending
        .lock()
        .map_err(|_| "修正状態を取得できません")? = None;
    let root = project.canonicalize().map_err(|error| error.to_string())?;
    let analyzed_root = result
        .root_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if root != analyzed_root {
        return Err("先に対象プロジェクトを再解析してください".into());
    }
    let candidate = result
        .cycles
        .iter()
        .filter_map(|cycle| cycle.suggestion.as_ref())
        .find(|item| item.source == source && item.line == line);
    let candidate = candidate.ok_or("循環改善候補が見つかりません。再解析してください")?;
    let kind = match candidate.kind {
        CycleSuggestionKind::TypeOnly => "type_only",
        CycleSuggestionKind::Runtime => "runtime",
        CycleSuggestionKind::Unknown => "unknown",
    };
    let tool = available_tools(&root)?
        .into_iter()
        .find(|tool| tool.id == tool_id)
        .ok_or("選択した外部ツールが見つかりません")?;
    if !tool.kinds.iter().any(|supported| supported == kind) {
        return Err(format!(
            "{} はこの循環候補の種類に対応していません",
            tool.label
        ));
    }
    let module = result
        .modules
        .iter()
        .find(|module| module.id == source)
        .ok_or("対象モジュールが見つかりません")?;
    let file = module
        .absolute_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !file.starts_with(&root) || file.extension().and_then(|ext| ext.to_str()) != Some("py") {
        return Err("対象ファイルは解析対象の Python ファイルである必要があります".into());
    }
    let original = fs::read(&file).map_err(|error| error.to_string())?;
    let diff = run_tool(&tool, &root, &file, source, &candidate.target, line, true)?;
    if fs::read(&file).map_err(|error| error.to_string())? != original {
        return Err(format!(
            "{} のプレビュー用コマンドがファイルを変更しました",
            tool.label
        ));
    }
    let preview = FixPreview {
        file: file.display().to_string(),
        diff: diff.clone(),
        tool: tool.label.clone(),
    };
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "修正状態を取得できません")?;
    *pending = (!diff.trim().is_empty()).then_some(PendingFix {
        root,
        file,
        source: source.into(),
        target: candidate.target.clone(),
        line,
        tool,
        original,
        diff,
    });
    Ok(preview)
}

pub fn apply(state: &FixState) -> Result<String, String> {
    let pending = state
        .pending
        .lock()
        .map_err(|_| "修正状態を取得できません")?
        .take()
        .ok_or("差分を再表示してから適用してください")?;
    let current = fs::read(&pending.file).map_err(|error| error.to_string())?;
    if current != pending.original {
        return Err("差分表示後に対象ファイルが変更されました。再度プレビューしてください".into());
    }
    if run_tool(
        &pending.tool,
        &pending.root,
        &pending.file,
        &pending.source,
        &pending.target,
        pending.line,
        true,
    )? != pending.diff
    {
        return Err("Ruff の修正内容が変わりました。再度プレビューしてください".into());
    }
    if fs::read(&pending.file).map_err(|error| error.to_string())? != pending.original {
        return Err("Ruff 実行前に対象ファイルが変更されました。再度プレビューしてください".into());
    }
    run_tool(
        &pending.tool,
        &pending.root,
        &pending.file,
        &pending.source,
        &pending.target,
        pending.line,
        false,
    )?;
    let updated = fs::read(&pending.file).map_err(|error| error.to_string())?;
    if updated == pending.original {
        return Err(format!(
            "{} はファイルを変更しませんでした",
            pending.tool.label
        ));
    }
    Ok(pending.file.display().to_string())
}

fn ruff_executable(root: &Path) -> PathBuf {
    for relative in [
        ".venv/bin/ruff",
        "venv/bin/ruff",
        ".venv/Scripts/ruff.exe",
        "venv/Scripts/ruff.exe",
    ] {
        let candidate = root.join(relative);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("ruff")
}

fn available_tools(root: &Path) -> Result<Vec<FixTool>, String> {
    let mut tools = vec![FixTool {
        id: "ruff".into(),
        label: "Ruff (TC001)".into(),
        kinds: vec!["type_only".into()],
        command: ruff_executable(root),
        preview_args: vec![
            "check",
            "--select",
            "TC001",
            "--unsafe-fixes",
            "--no-cache",
            "--diff",
            "{file}",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
        apply_args: vec![
            "check",
            "--select",
            "TC001",
            "--unsafe-fixes",
            "--no-cache",
            "--fix-only",
            "{file}",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
    }];
    let Ok(content) = fs::read_to_string(root.join("moduleloom.toml")) else {
        return Ok(tools);
    };
    let document: toml::Value = content
        .parse()
        .map_err(|error| format!("moduleloom.toml: {error}"))?;
    let Some(table) = document.get("fix_tools").and_then(toml::Value::as_table) else {
        return Ok(tools);
    };
    for (id, value) in table {
        if id == "ruff" {
            return Err("fix_tools.ruff は予約済みです".into());
        }
        let command = value
            .get("command")
            .and_then(toml::Value::as_str)
            .ok_or_else(|| format!("fix_tools.{id}.command が必要です"))?;
        let preview_args = string_array(value.get("preview_args"))
            .ok_or_else(|| format!("fix_tools.{id}.preview_args が必要です"))?;
        let apply_args = string_array(value.get("apply_args"))
            .ok_or_else(|| format!("fix_tools.{id}.apply_args が必要です"))?;
        let kinds = string_array(value.get("kinds"))
            .unwrap_or_else(|| vec!["type_only".into(), "runtime".into(), "unknown".into()]);
        if kinds
            .iter()
            .any(|kind| !matches!(kind.as_str(), "type_only" | "runtime" | "unknown"))
        {
            return Err(format!("fix_tools.{id}.kinds に不明な種類があります"));
        }
        let command_path = PathBuf::from(command);
        let command_path = if command_path.is_absolute() || command_path.components().count() == 1 {
            command_path
        } else {
            root.join(command_path)
        };
        tools.push(FixTool {
            id: id.clone(),
            label: value
                .get("label")
                .and_then(toml::Value::as_str)
                .unwrap_or(id)
                .into(),
            kinds,
            command: command_path,
            preview_args,
            apply_args,
        });
    }
    Ok(tools)
}

fn string_array(value: Option<&toml::Value>) -> Option<Vec<String>> {
    value?
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_string))
        .collect()
}

fn run_tool(
    tool: &FixTool,
    root: &Path,
    file: &Path,
    source: &str,
    target: &str,
    line: usize,
    preview: bool,
) -> Result<String, String> {
    let args = if preview {
        &tool.preview_args
    } else {
        &tool.apply_args
    };
    let expanded: Vec<String> = args
        .iter()
        .map(|arg| {
            arg.replace("{project}", &root.display().to_string())
                .replace("{file}", &file.display().to_string())
                .replace("{source}", source)
                .replace("{target}", target)
                .replace("{line}", &line.to_string())
        })
        .collect();
    let mut command = Command::new(&tool.command);
    command.current_dir(root).args(&expanded);
    let output = command.output().map_err(|error| {
        format!(
            "{} を起動できません: {error}。実行ファイルの配置を確認してください",
            tool.label
        )
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success()
        && !(preview && output.status.code() == Some(1) && !stdout.trim().is_empty())
    {
        return Err(format!("{} の実行に失敗しました: {stderr}", tool.label));
    }
    Ok(stdout)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn previews_external_diff_then_applies_only_if_file_is_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".venv/bin")).unwrap();
        let tool = root.join(".venv/bin/ruff");
        fs::write(&tool, "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"--diff\" ]; then echo 'ruff diff'; exit 1; fi\n  last=\"$arg\"\ndone\nprintf '\\n# fixed\\n' >> \"$last\"\n").unwrap();
        let mut permissions = fs::metadata(&tool).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&tool, permissions).unwrap();
        fs::write(
            root.join("a.py"),
            "from b import B\ndef f(x: B):\n    pass\n",
        )
        .unwrap();
        fs::write(root.join("b.py"), "from a import f\nclass B:\n    pass\n").unwrap();
        let result = moduleloom_analyzer::analyze_directory(root).unwrap();
        let item = result
            .cycles
            .iter()
            .filter_map(|cycle| cycle.suggestion.as_ref())
            .find(|item| matches!(item.kind, CycleSuggestionKind::TypeOnly))
            .unwrap();
        let state = FixState::default();
        let first_preview =
            preview(root, &result, &item.source, item.line, "ruff", &state).unwrap();
        assert_eq!(first_preview.diff.trim(), "ruff diff");
        let file = apply(&state).unwrap();
        assert!(fs::read_to_string(&file).unwrap().contains("# fixed"));

        preview(root, &result, &item.source, item.line, "ruff", &state).unwrap();
        fs::write(&file, "user edit\n").unwrap();
        assert!(apply(&state).unwrap_err().contains("変更されました"));
        assert_eq!(fs::read_to_string(file).unwrap(), "user edit\n");
    }

    #[test]
    fn configured_tool_is_selectable_and_receives_cycle_context() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("tools")).unwrap();
        let executable = root.join("tools/fixer");
        fs::write(&executable, "#!/bin/sh\nif [ \"$1\" = preview ]; then echo \"diff $3 $4 $5\"; exit 1; fi\nprintf '\\n# fixed\\n' >> \"$2\"\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).unwrap();
        fs::write(root.join("moduleloom.toml"), "[fix_tools.custom]\nlabel = \"Custom fixer\"\ncommand = \"tools/fixer\"\npreview_args = [\"preview\", \"{file}\", \"{source}\", \"{target}\", \"{line}\"]\napply_args = [\"apply\", \"{file}\"]\nkinds = [\"runtime\"]\n").unwrap();
        let tools = list_tools(root).unwrap();
        let custom = tools.iter().find(|tool| tool.id == "custom").unwrap();
        assert_eq!(custom.kinds, vec!["runtime"]);
        let file = root.join("a.py");
        fs::write(&file, "from b import thing\nvalue = thing()\n").unwrap();
        fs::write(
            root.join("b.py"),
            "from a import value\ndef thing():\n    return 1\n",
        )
        .unwrap();
        let result = moduleloom_analyzer::analyze_directory(root).unwrap();
        let candidate = result
            .cycles
            .iter()
            .filter_map(|cycle| cycle.suggestion.as_ref())
            .find(|item| matches!(item.kind, CycleSuggestionKind::Runtime))
            .unwrap();
        let state = FixState::default();
        assert!(preview(
            root,
            &result,
            &candidate.source,
            candidate.line,
            "ruff",
            &state
        )
        .is_err());
        let shown = preview(
            root,
            &result,
            &candidate.source,
            candidate.line,
            "custom",
            &state,
        )
        .unwrap();
        assert_eq!(
            shown.diff.trim(),
            format!(
                "diff {} {} {}",
                candidate.source, candidate.target, candidate.line
            )
        );
        apply(&state).unwrap();
        assert!(fs::read_to_string(file).unwrap().contains("# fixed"));
    }
}
