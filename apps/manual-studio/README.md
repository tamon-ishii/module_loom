# Manual Studio

ドキュメント生成専用のデスクトップアプリです。ModuleLoom本体を起動せず、Markdownの編集、撮影、UI Map、シナリオ、HTML公開を扱えます。

## Linuxの配布版

Debian/Ubuntuでは、作成した `.deb` をインストールするとアプリ一覧に **Manual Studio** が表示されます。

```sh
sudo apt install "./Manual Studio_0.1.0_amd64.deb"
manual-studio
```

Markdown編集と撮影にはNode.jsやRust、ModuleLoom本体は不要です。HTML生成やAI生成には、下記の外部ツールが必要です。

## 開発環境から起動

ローカル起動はリポジトリのルートで実行します。

```sh
python3 start_manual_studio.py
```

初回だけ依存を準備してビルドします。ソースを変更した後は `python3 start_manual_studio.py --build`、変更を随時反映する開発モードは `python3 start_manual_studio.py --dev` を使います。Windowsでは `python start_manual_studio.py` を実行してください。スクリプトは別のフォルダーから絶対パスで実行することもできます。Linux/macOS用の `./start-manual-studio.sh` も利用できます。

配布用アプリは `npm run manual:bundle` で作成します。LinuxでDebianパッケージのみを作る場合は `npm run manual:bundle -- --bundles deb` を実行します。出力はリポジトリの `target/release/bundle/` です。RustとTauriの各OSのビルド依存が必要です。共有の解析ライブラリはアプリに組み込まれます。

ブラウザーで開発するときは `cargo build -p manual-core --bin manualctl` の後に `npm run manual:dev` を実行します。ブラウザー版でも実際のプロジェクトを読み書きします。

## 最初にすること

1. 対象プロジェクトのフォルダーを開きます。
2. 左側から原稿を選ぶか、＋でページを作ります。
3. Markdownを編集し、右側のプレビューを確認して保存します。Ctrl/Cmd+Sでも保存できます。
4. 必要なら「撮影の指示」「AI文章の指示」「依存図の指示」を原稿に追加して保存します。
5. 「画像・文章・図」で各指示を実行し、「生成・公開」で下書きビルドを確認します。

「別ウィンドウで編集」で原稿ごとの編集ウィンドウを開けます。外部エディタや別ウィンドウで変更された原稿は上書きせずエラーにします。編集中の内容をコピーしてから「読み直す」で最新の原稿を開いてください。

編集プレビューは通常のMarkdown用です。MermaidやMkDocs独自の表示はHTMLビルドで確認します。

## スクリーンショットの更新

初回だけ対象ウィンドウと除外する余白を指定して撮影します。以後は「同じ撮影元で更新」で再撮影できます。ウィンドウの識別にはタイトルを使い、再起動後の一時的なウィンドウIDは保存しません。同じタイトルの候補が複数ある場合は選び直してください。

画面を開く操作も繰り返したい場合は「撮影手順」でシナリオを保存し、対象画像の撮影手順に設定します。撮影元はプロジェクトの `manual/capture_sources.json` に保存されます。

WaylandではOSの撮影ダイアログで毎回選択が必要です。macOSでは画面収録の権限が必要です。

## UI Mapの使い方

UI Mapは画面名、ボタンや入力欄、操作対象のセレクターを一覧にした情報です。原稿の説明や撮影手順を作るときに参照します。

- 自分のHTML/TypeScriptアプリ: 「ソースから更新」で一覧を作ります。
- 起動中のWebアプリ: URLを指定して「Web画面を観測」で表示中の要素を補います。Playwrightとブラウザーが必要です。
- 外部アプリ: 観測JSONを取り込むか、デスクトップの「操作対象を調べる」でアクセシビリティ情報を確認し、撮影手順を作ります。

UI Mapだけではクリックや撮影は実行されません。手順の実行は「撮影手順」で行います。保存先は `manual/ui_map.json` です。

## 生成に必要なツール

Markdown編集とネイティブ撮影はアプリ内で動作します。HTML出力にはPython/MkDocs、AI生成には選択したAI CLI、WebシナリオにはNode.js/Playwrightが必要です。デスクトップ自動操作は対象アプリがアクセシビリティ情報を公開している必要があります。

HTML生成には `mkdocs-material` をインストールしてください。プロジェクトごとの環境を使う例:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install mkdocs-material
```

Windowsでは `.venv\Scripts\python -m pip install mkdocs-material` を実行し、その環境を有効にしてアプリを起動します。MkDocsが見つからない場合は、ビルド結果にHTML生成をスキップしたことが表示されます。

## 開発時の動作確認

`cargo test -p manual-core` と `npm run manual:build` で共有エンジンとUIを確認します。
`cargo build -p manual-core --bin manualctl` の後に `npm run manual:dev` を起動し、別のターミナルで `node scripts/smoke_manual_studio.mjs` を実行すると、Chromeで編集・プレビュー・保存・別ウィンドウの保存競合・空のプロジェクトへの切り替え・ページ作成・保存したWebシナリオからの再撮影を確認できます。
MkDocsがあればHTML出力まで、なければスキップ表示を確認します。検証用プロジェクトは一時フォルダーに作成して終了時に削除します。Google ChromeとNode.jsが必要です。
開発サーバーも自動で起動・終了する場合は `node scripts/smoke_manual_studio.mjs --start-server` を使います。CIではLinux・Windows・macOSでこの操作確認を実行します。

配布バイナリは `node scripts/smoke_manual_integrations.mjs --native target/release/manual-studio` で、起動・撮影・アプリ再起動後の再撮影を確認できます。Windowsでは `.exe` を自動で補います。Linux/X11・Windows・macOSのデスクトップ環境で実行し、macOSでは画面収録の権限が必要です。他のManual Studioウィンドウを閉じてから実行してください。
実際のAI CLIでの生成は `node scripts/smoke_manual_integrations.mjs --ai agy` で確認できます。最後の引数には設定可能なAI CLIのIDを指定します。選択したCLIのアカウントを使い、一時プロジェクトのソースを説明する文章を生成して根拠コメントを検証します。

## 構成

- `crates/manual-core`: 原稿、撮影、シナリオ、UI Map、生成・公開、編集API。
- `crates/analysis-core`: Python解析と依存図の共有エンジン。
- `apps/manual-studio`: 専用UIとTauriホスト。
- `crates/analyzer`: 既存CLIの互換ホスト。

現在は同じCargoワークスペースで管理しています。独立した起動・配布に対応し、別リポジトリへの移動には共有クレートも含めて移す必要があります。
