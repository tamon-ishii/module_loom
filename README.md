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
