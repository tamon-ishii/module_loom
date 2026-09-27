use std::fs;
use std::path::Path;

use super::config::{config_path, read_config, ManualConfig, MkDocsConfig, DEFAULT_BRIEF};
use super::task::{collect_markdown_files, utc_now};
use crate::analyze_directory;

pub fn init_template(root: &Path, template_type: &str, clear: bool) -> Result<(), String> {
    let existing_cfg = read_config(root);
    let project_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("プロジェクト");

    let docs_dir_name = if existing_cfg.docs.trim().is_empty() {
        "docs".to_string()
    } else {
        existing_cfg.docs.clone()
    };
    let templates = root.join(&docs_dir_name);

    if templates.is_dir() {
        let existing = collect_markdown_files(&templates);
        if !existing.is_empty() {
            if !clear {
                return Err("EXISTING_DOCS_CONFIRM_REQUIRED".to_string());
            }
            // 安全のため既存ファイルをバックアップ
            let backup_dir = root
                .join("manual")
                .join(".backup")
                .join(utc_now().replace(':', "-"));
            let _ = fs::create_dir_all(&backup_dir);
            for old_file in &existing {
                let rel = old_file.strip_prefix(&templates).unwrap_or(old_file);
                let dest = backup_dir.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(old_file, &dest);
                let _ = fs::remove_file(old_file);
            }
        }
    } else {
        fs::create_dir_all(&templates).map_err(|e| e.to_string())?;
    }

    // manual_setting.json を確実に生成
    let site_name = match template_type {
        "api" => format!("{project_name} アーキテクチャ & API リファレンス"),
        _ => format!("{project_name} 利用マニュアル"),
    };
    let agent = if ["codex", "claude", "gemini", "grok", "agy"].contains(&existing_cfg.agent.as_str()) {
        existing_cfg.agent.clone()
    } else {
        "codex".to_string()
    };
    let new_config = ManualConfig {
        docs: docs_dir_name,
        output: if existing_cfg.output.trim().is_empty() {
            "manual".to_string()
        } else {
            existing_cfg.output
        },
        targets: vec!["docs".to_string(), "README.md".to_string()],
        format: "mkdocs".to_string(),
        agent,
        model: existing_cfg.model,
        mkdocs: MkDocsConfig {
            site_name,
            theme: "material".to_string(),
            language: "ja".to_string(),
            use_directory_urls: false,
        },
    };
    let setting_dest = config_path(root);
    let json_bytes = serde_json::to_string_pretty(&new_config).map_err(|e| e.to_string())?;
    fs::write(&setting_dest, format!("{json_bytes}\n"))
        .map_err(|e| format!("Failed to write manual_setting.json: {e}"))?;

    let brief_path = root.join("manual").join("brief.md");
    if !brief_path.is_file() {
        if let Some(parent) = brief_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&brief_path, format!("{DEFAULT_BRIEF}\n"));
    }

    match template_type {
        "api" => init_api_template(root, &templates, project_name)?,
        _ => init_manual_template(root, &templates, project_name)?,
    }

    Ok(())
}

fn init_manual_template(_root: &Path, templates: &Path, project_name: &str) -> Result<(), String> {
    let index_md = format!(
        r#"# {project_name} 利用マニュアル

このドキュメントでは、{project_name} の主な機能と操作方法について説明します。

<!-- ai:task id=overview-screenshot kind=screenshot
メイン画面の全体外観をキャプチャ
-->

<!-- ai:task id=overview-intro-text kind=text
本ツールの目的と提供する価値を読者に向けて簡潔に説明する
-->

## ドキュメント構成
- [はじめに・クイックスタート](quickstart.md): 基本的な操作手順と初期設定
- [主な機能と操作方法](features.md): 各画面の詳しい機能解説
- [設定とカスタマイズ](settings.md): 動作環境と各種設定
"#
    );
    fs::write(templates.join("index.md"), index_md).map_err(|e| e.to_string())?;

    let quickstart_md = format!(
        r#"# クイックスタートガイド

本ツールの基本的な使い方と操作手順をステップ順に説明します。

## ステップ 1: 起動とプロジェクト選択
<!-- ai:task id=quickstart-step1-screenshot kind=screenshot
起動直後の画面とプロジェクト選択エリアのスクリーンショット
-->

<!-- ai:task id=quickstart-step1-text kind=text
対象プロジェクトを開いて初期解析を開始する手順を解説
-->

## ステップ 2: 主要機能の実行
<!-- ai:task id=quickstart-step2-screenshot kind=screenshot
解析結果が表示されたメインワークスペースのスクリーンショット
-->

<!-- ai:task id=quickstart-step2-text kind=text
結果画面の見方と基本的な操作方法を解説
-->
"#
    );
    fs::write(templates.join("quickstart.md"), quickstart_md).map_err(|e| e.to_string())?;

    let features_md = format!(
        r#"# 主な機能と操作方法

{project_name} に備わっている機能の詳細と活用方法を説明します。

## 主要機能一覧
<!-- ai:task id=features-main-screenshot kind=screenshot
主要機能パネルまたはダイアログのスクリーンショット
-->

<!-- ai:task id=features-guide-text kind=text
主要機能の操作方法、パラメータ、活用のポイントを解説
-->
"#
    );
    fs::write(templates.join("features.md"), features_md).map_err(|e| e.to_string())?;

    let settings_md = format!(
        r#"# 設定とカスタマイズ

環境設定およびオプション項目について説明します。

<!-- ai:task id=settings-screenshot kind=screenshot
設定モーダルまたは設定画面のスクリーンショット
-->

<!-- ai:task id=settings-guide-text kind=text
各設定項目の意味とおすすめの設定値を解説
-->
"#
    );
    fs::write(templates.join("settings.md"), settings_md).map_err(|e| e.to_string())?;

    Ok(())
}

fn init_api_template(root: &Path, templates: &Path, project_name: &str) -> Result<(), String> {
    let index_md = format!(
        r#"# {project_name} アーキテクチャ & API リファレンス

本ドキュメントは、{project_name} の内部モジュール構造、依存関係、および公開 API に関する技術仕様書です。

## システム全体アーキテクチャ
<!-- ai:task id=system-architecture-diagram kind=diagram
プロジェクト全体の主要モジュール間依存関係をMermaidダイアグラムで生成
-->

## 仕様書構成
- [モジュール依存関係とアーキテクチャ](architecture.md): レイヤー構造と依存ルール
- [API リファレンス](api.md): モジュール・クラス・関数仕様
"#
    );
    fs::write(templates.join("index.md"), index_md).map_err(|e| e.to_string())?;

    let architecture_md = format!(
        r#"# モジュール依存関係とアーキテクチャ

プロジェクト内のモジュール構造およびパッケージ間の依存関係を整理した技術仕様です。

## パッケージ間依存図
<!-- ai:task id=package-dependency-diagram kind=diagram
パッケージ間の推移的依存とレイヤー構造をMermaidダイアグラムで生成
-->

## 循環インポート・メトリクス
コード解析によって検出されたモジュール間結合度および循環参照の状況です。
"#
    );
    fs::write(templates.join("architecture.md"), architecture_md).map_err(|e| e.to_string())?;

    // API リファレンス：AST解析からモジュール一覧を自動生成
    let mut api_content = format!(
        r#"# API リファレンス

本プロジェクトで定義されている主要モジュール、クラス、および関数の一覧です。

"#
    );

    if let Ok(analysis) = analyze_directory(root) {
        if !analysis.modules.is_empty() {
            for m in &analysis.modules {
                api_content.push_str(&format!("## モジュール `{}`\n\n", m.id));
                if let Some(ref doc) = m.docstring {
                    api_content.push_str(&format!("{}\n\n", doc.trim()));
                }
                if !m.classes.is_empty() {
                    api_content.push_str("### クラス一覧\n");
                    for c in &m.classes {
                        api_content.push_str(&format!("- **`{}`**", c.name));
                        if let Some(ref doc) = c.docstring {
                            let first_line = doc.lines().next().unwrap_or("").trim();
                            if !first_line.is_empty() {
                                api_content.push_str(&format!(": {}", first_line));
                            }
                        }
                        api_content.push('\n');
                    }
                    api_content.push('\n');
                }
                if !m.functions.is_empty() {
                    api_content.push_str("### 関数一覧\n");
                    for f in &m.functions {
                        api_content.push_str(&format!("- **`{}()`**", f.name));
                        if let Some(ref doc) = f.docstring {
                            let first_line = doc.lines().next().unwrap_or("").trim();
                            if !first_line.is_empty() {
                                api_content.push_str(&format!(": {}", first_line));
                            }
                        }
                        api_content.push('\n');
                    }
                    api_content.push('\n');
                }
            }
        } else {
            api_content.push_str("モジュールが検出されませんでした。\n");
        }
    } else {
        api_content.push_str("コード解析を実行してモジュール仕様を抽出します。\n");
    }

    fs::write(templates.join("api.md"), api_content).map_err(|e| e.to_string())?;

    Ok(())
}
