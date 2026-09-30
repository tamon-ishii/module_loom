# ModuleLoom

<img src="module_loom.png" alt="ModuleLoom の画面" width="720">

Python プロジェクトの依存関係を可視化し、コードを診断するツールです。デスクトップアプリ、PyCharm プラグイン、VS Code 拡張機能、CLI を提供します。

<!-- ai:task id=readme-overview kind=screenshot
ModuleLoom の画面と依存関係図が見えるデスクトップ画面を撮影する。
-->

<!-- ai:generated id=readme-overview kind=screenshot source-sha256=b17f94877f15a89ee72c5dbfc06b8d221ebc237607d1364e483bfee066054301 prompt-b64=TW9kdWxlTG9vbSDjga7nlLvpnaLjgajkvp3lrZjplqLkv4Llm7PjgYzopovjgYjjgovjg4fjgrnjgq/jg4jjg4Pjg5fnlLvpnaLjgpLmkq7lvbHjgZnjgovjgII= -->
![ModuleLoom デスクトップ版のモジュール一覧と依存関係図](manual/assets/readme-overview.png)
<!-- /ai:generated -->

## 主な機能

1. **依存関係の可視化** — モジュール間の import をグラフで表示します。循環インポートの経路や import 行を確認でき、モジュール間の経路も検索できます。
2. **ドキュメント生成** — Markdown 原稿に指定した画面のスクリーンショットと Mermaid の依存図を更新できます。docstring と型注釈から API リファレンスを含む MkDocs プロジェクトも生成します。
3. **コード診断** — 循環、肥大化、複雑度、重複コード、依存宣言やアーキテクチャルールの問題を検出します。結果は画面または CLI の JSON 出力で確認できます。

詳しい使い方や画面の操作手順は [利用マニュアル](https://tamon-ishii.github.io/module_loom/) をご覧ください。

## インストール

[GitHub Releases](https://github.com/tamon-ishii/module_loom/releases) から利用環境に合うファイルをダウンロードしてください。

| 用途 | 配布ファイル |
| --- | --- |
| PyCharm | `ModuleLoom-PyCharm-*.jar` |
| VS Code | `ModuleLoom-VSCode-*.vsix` |
| Windows デスクトップ | `ModuleLoom-Desktop-windows-x64-*.exe` |
| Linux デスクトップ | `ModuleLoom-Desktop-linux-x64-*.AppImage` または `.deb` |
| macOS デスクトップ | `ModuleLoom-Desktop-macos-*-*.dmg` |
| CLI | `ModuleLoom-CLI-*.zip` |

PyCharm は「Install Plugin from Disk」、VS Code は「Install from VSIX」からインストールします。CLI のアーカイブを展開すると `moduleloom-analyze`（Windows では `.exe`）が入っています。

## CLI の例

```sh
moduleloom-analyze --check ./my-project
moduleloom-analyze --diagnostics ./my-project > diagnostics.json
moduleloom-analyze --mkdocs ./moduleloom-docs ./my-project
```

`--check` は解析エラー、アーキテクチャルール違反、依存宣言の問題がある場合に終了コード 1 を返します。循環や肥大化も失敗条件に含める場合は `--check-all` を使用します。診断の指摘は `--diagnostics` で JSON に出力できます。

解析対象のルートに `moduleloom.toml` を置くと、肥大化の閾値やアーキテクチャルールを設定できます。

## ドキュメント専用アプリ

[Manual Studio](apps/manual-studio/README.md) は、Markdown編集・プレビュー・撮影・HTML生成を独立したウィンドウで扱えます。開発環境での起動は `npm run manual:app` です。
