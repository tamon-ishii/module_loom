# ModuleLoom

Python モジュールの依存関係、循環インポート、肥大化を可視化するツールです。デスクトップアプリ、PyCharm プラグイン、VS Code 拡張を別々に配布します。

## GitHub からインストール

[Releases](https://github.com/tamon-ishii/module_loom/releases) から使用する版のファイルを選んでください。

| 用途 | ダウンロードするファイル | インストール |
| --- | --- | --- |
| PyCharm | `ModuleLoom-PyCharm-*.jar` | 設定 → プラグイン → 歯車 → **Install Plugin from Disk** |
| VS Code | `ModuleLoom-VSCode-*.vsix` | 拡張機能画面の `…` → **Install from VSIX** |
| Windows デスクトップ | `ModuleLoom-Desktop-windows-x64-*.exe` | インストーラーを実行 |
| Linux デスクトップ | `ModuleLoom-Desktop-linux-x64-*.AppImage` または `.deb` | AppImage を実行、または deb をインストール |
| macOS デスクトップ | `ModuleLoom-Desktop-macos-*-*.dmg` | CPU に合う `x64` または `arm64` の DMG を開く |

PyCharm と VS Code の配布ファイルには、対応する OS の解析用実行ファイルを同梱しています。解析 CLI を単独で使う場合は `ModuleLoom-CLI-*.zip` を選んでください。現在の対象は Windows と Linux の x64、macOS の x64 と arm64 です。

## リリースの作成

`main` へのプッシュと手動実行では、ビルド結果を GitHub Actions の成果物として保存します。`v` で始まるタグをプッシュすると、3種類の配布ファイルと解析 CLI を GitHub Releases に公開します。

```sh
git tag v0.1.0
git push origin v0.1.0
```

タグの版は `src-tauri/tauri.conf.json` と `plugins/vscode/package.json` の版に合わせてください。

## プロジェクトごとの解析設定

解析対象プロジェクトの直下に `moduleloom.toml` を置くと、肥大化警告の閾値を変更できます。設定ファイルがない場合は、LOC 300、関数 20、クラス 10 が使われます。

```toml
[thresholds]
max_loc = 500
max_functions = 30
max_classes = 15
```

アーキテクチャルールも設定できます。`forbidden` は依存禁止、`independence` は相互依存禁止、`layers` は上位レイヤーから下位レイヤーへの一方向依存を検査します。

```toml
[architecture.forbidden.api_db]
source = "app.api"
target = "app.db"

[architecture.independence.web_domain]
modules = "app.web, app.domain"

[architecture.layers.app]
layers = "app.presentation, app.application, app.domain, app.infrastructure"
```

設定を変更した後は、次回の解析または自動更新時から反映されます。

CI では `--check` を付けると、アーキテクチャルール違反がある場合に終了コード 1 になります。

解析結果にはシンボル、関数呼び出し、循環依存、未使用候補、複雑度、結合度、セキュリティ診断、パッケージ依存も含まれます。モジュール詳細の「コールグラフを表示」から、選択モジュールに関係するシンボル呼び出しを確認できます。ノードのダブルクリックで定義位置を開けます。

「レポート出力」では JSON、HTML、Graphviz DOT を保存できます。解析結果はプロジェクトごとに直近 20 件までブラウザ内へ保存され、履歴表示とシンボル・依存関係の削除候補比較に使われます。

```sh
moduleloom-analyze --check ./my-project
```
