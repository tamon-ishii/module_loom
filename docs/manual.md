# ドキュメントを生成する

**ドキュメント生成**タブでは、Markdown 原稿と画面画像・依存図を管理し、MkDocs の HTML サイトを出力します。スクリーンショットと Mermaid 図は原稿内のタスクに対応します。

## 原稿と出力先を確認する

**設定**で対象プロジェクト、Markdown 原稿のフォルダー、HTML の出力先を確認します。この例では原稿が `docs/`、出力先が `manual/` です。

<!-- ai:task id=manual-settings kind=screenshot
ドキュメント生成の原稿パスと HTML 出力先の設定画面を撮影する。
-->

<!-- ai:generated id=manual-settings kind=screenshot created-at=2026-09-28T17:50:49Z source-sha256=33cf046d725fa0756cc07d1ce827a1b14debd940ead1a9786c6f7108cf4504c5 prompt-b64=44OJ44Kt44Ol44Oh44Oz44OI55Sf5oiQ44Gu5Y6f56i/44OR44K544GoIEhUTUwg5Ye65Yqb5YWI44Gu6Kit5a6a55S76Z2i44KS5pKu5b2x44GZ44KL44CC -->
![manual-settings](assets/manual-settings.png)
<!-- /ai:generated -->

<!-- ai:depends task=manual-settings file=index.html ui=#manual-settings-modal -->
<!-- ai:depends task=manual-settings file=src/main.ts -->

原稿がない場合は **テンプレート生成**から下書きを作れます。既存の原稿がある場合は、その内容を確認してから生成を実行してください。

<!-- ai:task id=manual-template kind=screenshot
テンプレート生成で原稿の種類を選ぶ画面を撮影する。
-->

<!-- ai:generated id=manual-template kind=screenshot prompt-b64=44OG44Oz44OX44Os44O844OI55Sf5oiQ44Gn5Y6f56i/44Gu56iu6aGe44KS6YG444G255S76Z2i44KS5pKu5b2x44GZ44KL44CC source-sha256=fb911cc7ddfb28214133f5c6edf9f8885cc99a84db446ef9ef010c96f442f7f0 -->
![テンプレート生成で選ぶ原稿の種類](assets/manual-screen.png)
<!-- /ai:generated -->

## 画像と図を更新する

原稿にスクリーンショットのタスクがある場合、更新対象アセットの **撮影指示をコピー**で `ai:task` の指示と保存先をコピーできます。対象アプリを開いて必要な画面を表示した後、Linux/X11・macOS・Windowsでは **ウィンドウを撮影**から対象ウィンドウを選択し、必要なら外枠の余白を除いてPNGを登録できます。macOSでは画面収録の権限が必要です。Linux/Waylandでは同じ操作からOSの撮影ダイアログを開き、対象ウィンドウを選択します。Waylandの選択方法はデスクトップ環境のポータル実装によって異なり、対話なしで任意のウィンドウを指定する機能はありません。撮影対象を自動操作するには別途AIエージェントやシナリオを使用します。既存のPNGは **PNGを登録** で指定できます。登録すると原稿の `ai:generated` に画像リンクが入ります。

依存図のタスクは **全ダイアグラム更新**で更新します。API リファレンスが必要な場合は **API ドキュメント生成**を使い、docstring と型注釈からモジュール別のページを作ります。

## ビルドして確認する

**下書きビルド**は未完成のタスクを残したままプレビューを作ります。右側の **HTML** 表示でページを確認し、画像や文章を直した後に **完成版ビルド**を実行します。完成版ビルドでは、未解決のタスクがあるとエラーになります。

<!-- ai:task id=manual-draft-build kind=screenshot
下書きビルドボタンと HTML プレビューが見える画面を撮影する。
-->

<!-- ai:generated id=manual-draft-build kind=screenshot prompt-b64=5LiL5pu444GN44OT44Or44OJ44Oc44K/44Oz44GoIEhUTUwg44OX44Os44OT44Ol44O844GM6KaL44GI44KL55S76Z2i44KS5pKu5b2x44GZ44KL44CC source-sha256=10e402e8ed5ada7d15ca22f89b4423cdc3683603043c9b24db4dc213183d1d88 -->
![下書きビルドボタンと HTML プレビュー](assets/draft-build-control.png)
<!-- /ai:generated -->

## AI タグの仕様

Markdown 原稿では、生成・撮影・更新する箇所を `ai:task` タグで指定します。タグは HTML コメントなので、生成前の原稿を通常の Markdown 表示にしても指示文は本文に表示されません。

```markdown
<!-- ai:task id=quickstart-guide kind=text
初めて使う人向けに、プロジェクトの指定手順を説明してください。
-->

<!-- ai:task id=overview-shot kind=screenshot
メイン画面を撮影してください。
-->

<!-- ai:task id=module-map kind=diagram
モジュール間の依存関係を図にしてください。
-->
```

`id` はタスクを識別する名前です。省略時は種類・ファイル名などから自動生成されます。明示する場合は小文字英字で始め、小文字英数字とハイフンだけを使います（`^[a-z][a-z0-9-]*$`）。ID はすべての原稿 Markdown ファイルを通じて重複しないようにします。

`kind` は `text`（説明文）、`screenshot`（画面画像）、`diagram`（Mermaid 図）のいずれかです。省略すると `text` として扱われます。タグの開始行の後で改行して指示を書き、終了の `-->` は別の行に置いてください。指示文は空にできません。

種類ごとに生成内容を分けます。`text` には説明文、`screenshot` には画像 Markdown、`diagram` には Mermaid コードブロックだけを置きます。画像の説明や図の注釈が必要な場合は、別の `kind=text` タスクを使います。

生成後も `ai:task` は更新指示として残し、その直下に同じ `id` の `ai:generated` ブロックを置きます。更新対象アセットの **タスク指示を編集**から本文を変更して保存すると、原稿の `ai:task` に反映されます。画像タスクでは保存した指示をコピーして撮影担当のエージェントに渡し、出来上がったPNGを登録します。テキストと図は次回の生成で指示を使って回答を更新します。指示や種類が変わると既存の回答は古い状態になります。下書きビルドでは未完了タスクを確認できますが、完成版ビルドには各タスクの最新の回答が必要です。

CLI から既存の Python コードに基づく MkDocs ページだけを生成する場合は、次のコマンドを使用します。

```sh
moduleloom-analyze --mkdocs ./moduleloom-docs ./sample_project
```

## UI Map と変更影響を確認する

CLI の `--manual ui-map --root .` は、アプリの HTML・TypeScript・JavaScript から UI Map を作り、`manual/ui_map.json` に保存します。生成された Map は参照元のファイルが変わると再解析されます。以前のバージョンで作った Map を再生成するには `--manual ui-map --root . --refresh` を実行します。手動で管理する場合は JSON の `source_hash` フィールドを削除してください。`manual/` と `docs/` の生成物は解析対象に含めません。

対象アプリを実際に操作できる AI や自動化ツールで画面を調べた場合、その観測結果を JSON に保存して `--manual ui-map-import --root . --input observation.json` で取り込めます。例:

```json
{
  "source": "http://127.0.0.1:3000/settings",
  "platform": "web",
  "views": [{
    "id": "settings",
    "name": "Settings",
    "elements": [
      {"id": "model", "selector": "#model", "name": "AI model", "role": "combobox"}
    ]
  }]
}
```

`source` には確認した URL または画面名を入れます。デスクトップアプリでは `platform` に `linux-x11` などを、`selector` にアクセシビリティ識別子などを記録できます。ModuleLoom は観測元と取り込み時刻を保存し、静的解析の要素と統合します。対象プロジェクトの UI ソースが変わると、古い観測結果は Map から外れます。外部アプリのコード変更は検知できないため、その場合は再探索して取り込み直してください。

`--manual impact --root . --ref HEAD` は、Git の変更と原稿の関連付けから更新候補ページを表示します。実行時に依存関係グラフを作り直します。自動推測は主に Python モジュールと UI 要素 ID に基づきます。明示した `file` は言語を問わず、Git の変更パスと照合します。結果は確認候補として扱ってください。操作シナリオの実行や文章の事実検証は行いません。

ページやタスクとコードの関係が分かっている場合は、原稿に依存関係を明記できます。

```markdown
<!-- ai:depends file=src/settings.rs -->
<!-- ai:depends task=settings-shot file=src/settings.rs ui=#model -->
```

`task` を省くとページ全体、指定すると同じページの `ai:task` に結び付きます。`file` はプロジェクト内の相対パスで、Python 以外のファイルも指定できます。`symbol` と `ui` も指定できます。複数のファイルを結ぶ場合は行を分けてください。宣言は HTML コメントとして扱われ、マニュアル本文には表示されません。`--manual deps --root .` の `evidence` には明示した関係を `ai:depends` として記録します。推測で見つけた関係は `text-match` として区別します。

変更後に更新対象を確認するには `--manual impact-plan --root . --ref HEAD` を実行します。結果の `generate_tasks` は自動更新できる文章・図、`manual_tasks` は撮影などの手作業が必要なタスク、`approved_tasks` は承認済みで自動更新しないタスクです。`page_only` は変更の影響があるものの、個別のタスクまで特定できないページです。

`--manual generate-impacted --root . --ref HEAD` は、同じ計画の `generate_tasks` だけを順に更新します。実行前に `impact-plan` で対象を確認してください。途中で生成が失敗した場合はその時点で終了し、それ以前に更新したタスクは残ります。スクリーンショットや承認済みタスク、ページ単位の候補は自動更新しません。

### 操作シナリオ（Web・デスクトップ）

デスクトップ版、PyCharm 版、VS Code 版の **ドキュメント生成 → マニュアルの保守と検証** からも、更新候補の確認、Web UI 探索、UI Map の更新と観測 JSON の取り込み、シナリオの保存・読み込み・実行、E2E、根拠確認、読者別ビルドを操作できます。外部アプリの画面を調べた観測 JSON は **UI Map を更新・取り込む** にパスを指定します。シナリオを保存した後、プレビューで対象ページを選び **表示中ページに紐づけ** を押すと、そのページへ `ai:scenario` を追加します。

Web アプリでは操作を JSON ファイルに記録し、順に実行できます。対象プロジェクトに Node.js、`playwright-core`、Google Chrome が必要です。`npm install --save-dev playwright-core` で依存を追加してください。Chrome が標準の場所にない場合は `MODULELOOM_CHROME_PATH` に実行ファイルのパスを設定します。

```json
{
  "version": 1,
  "base_url": "http://localhost:3000/",
  "steps": [
    {"goto": "/"},
    {"click": "#settings-button"},
    {"expect_visible": "#settings-dialog"},
    {"screenshot": {"task": "settings-shot", "selector": "#settings-dialog"}}
  ]
}
```

原稿には `settings-shot` という `kind=screenshot` の `ai:task` を用意します。`--manual scenario-run --root . --input scenario.json` を実行すると、指定した要素だけを `docs/assets/settings-shot.png` に撮影し、タスクの `ai:generated` に画像リンクを登録します。`selector` を省けば表示中のページ全体を撮影します。Web 操作には `goto`、`click`、`fill`（`{"selector":"#name","value":"example"}`）、`expect_visible`、`screenshot` を使用できます。失敗時はステップ番号を表示し、タスクへの登録は行いません。

デスクトップアプリでは `platform` を `desktop` にします。次の例はアプリを起動し、タイトルに `Settings` を含むウィンドウを選択して撮影します。`launch` のプログラムは対象プロジェクトを作業ディレクトリとして起動します。既に起動しているアプリなら `launch` は省けます。

```json
{
  "version": 1,
  "platform": "desktop",
  "steps": [
    {"launch": {"program": "my-app", "args": []}},
    {"window": "Settings"},
    {"fill": {"selector": "text_field[name='Name']", "value": "Example"}},
    {"expect_value": {"selector": "text_field[name='Name']", "value": "Example"}},
    {"press": "button[name='Save']"},
    {"expect_visible": "static_text[name='Saved']"},
    {"screenshot": {"task": "settings-shot", "selector": "static_text[name='Saved']", "inset": 8}}
  ]
}
```

`window` はタイトルで選択し、出現を最大 10 秒待ちます。xa11y のセレクタを使う操作は `press`、`focus`、`toggle`、`select`、`scroll_into_view`、`fill`、`text`、`expect_visible`、`expect_hidden`、`expect_enabled`、`expect_disabled`、`expect_focused`、`expect_value` です。`fill` は現在の値を置き換え、`text` はカーソル位置へ追加入力します。`text` は文字列なら現在の入力先へ送信し、`{"selector":"text_field[name='Name']","value":"Ada"}` なら指定要素に直接入力します。`key` は `"Ctrl+S"`、または `{"selector":"text_field[name='Name']","keys":"Ctrl+A"}` と指定できます。後者は要素にフォーカスしてから送信するため、Wayland ではこちらを使用してください。


`screenshot` に `selector` を指定すると xa11y でその要素を撮影し、省くとウィンドウ全体を撮影します。`inset` は撮影範囲の内側の余白です。`expect_window` はウィンドウの出現だけを確認します。`click` の座標は選択したウィンドウの左上から指定します。`click` と文字列形式の `text`・`key` には xa11y の入力シミュレーションを使います。`wait_ms` は最大 30000 ミリ秒の待機です。最初から対象ウィンドウが分かる場合はトップレベルの `window` にタイトルまたは一覧の `query`（例: `app:zenity::Settings`）を指定できます。macOS ではアクセシビリティと入力の権限が必要です。Linux/Wayland の入力シミュレーションには `/dev/uinput` の権限が必要です。Wayland でウィンドウ全体を撮影する際はシステムのポータルダイアログで対象を選びます。Wayland で要素を撮影する場合は対象を前面に表示し、アクセシビリティ情報と画面撮影の許可を用意してください。

セレクタを調べるには、画面の **アクセシビリティのウィンドウ一覧** から対象を選び **要素を表示** を押します。CLI の `--manual list-accessible-windows --root .` は、現在のプロセスに限る `id` と、シナリオで使う `query` を返します。`--manual inspect-window --root . --window 'pid:1234:/example/window'` で選んだウィンドウの要素ツリーを表示できます。`id` は一覧の更新やアプリ再起動で変わることがあるため、シナリオの `window` には `query` の値（例: `app:zenity::Settings`）を設定してください。これはアプリ名とタイトルで対象を探すため、プロセス ID が変わっても利用できます。要素ツリーの役割と名前から、たとえば `button[name='Save']` のような xa11y セレクタを作成します。

`--manual scenario-test --root . --input scenario.json` は同じ操作を実行しますが、撮影画像を原稿へ登録しません。マニュアルの操作手順を CI で確認する場合は、原稿に `<!-- ai:scenario file=manual/scenarios/settings.json -->` を記載し、`--manual e2e --root .` を実行します。参照されたシナリオを順に実行し、失敗したページとステップを報告します。シナリオの操作は実際のアプリに作用するため、テスト用のデータと環境を使用してください。

### 実画面から UI Map を更新

Web アプリを起動した状態で `--manual ui-explore --root . --url http://localhost:3000/ --max-pages 10` を実行します。同一オリジンのナビゲーションリンクとタブを巡回し、表示中の ID または `data-testid` を持つ操作要素を収集して `manual/ui_observations.json` に保存します。既存の静的 UI Map に統合され、ソースが変わると観測結果は期限切れになります。ログアウトや削除に見えるリンクは巡回対象から除外します。フォーム送信や一般的なボタン操作は自動探索しません。
<!-- ai:fact {"claim":"Web UI の探索には Playwright を使用する","file":"crates/analyzer/src/manual/explore_runner.mjs","contains":"playwright-core"} -->

### 生成文の根拠確認

文章中の具体的な主張には、確認した根拠を HTML コメントで付けられます。

```markdown
設定画面には保存ボタンがあります。
<!-- ai:fact {"claim":"設定画面に保存ボタンがある","ui":"#save","file":"src/settings.rs","contains":"save_settings"} -->
```

`--manual fact-check --root .` は指定された UI 要素、Python シンボル、ファイル、およびファイル内の文字列を確認します。`--check` を付けると根拠が見つからない場合と、生成文章タスクに根拠タグがない場合にエラーで終了します。AI が新しい文章に `ai:fact` を付けた場合、生成結果の保存前にも検査します。`--ai` を付けると設定済みのAI CLIが生成文中の具体的な主張を追加抽出し、プロジェクトの直接的な根拠と照合します。`--check --ai` では追加確認に成功した文章タスクは根拠タグがなくても合格します。デスクトップ・IDE画面では **AIで生成文全体の主張を追加確認する** を選んでから **根拠を確認** を押します。AIによる抽出と判断にも誤りはあり得るため、確認結果は文章の正しさの保証ではありません。

### 読者別のマニュアル

ページの先頭に `<!-- ai:audience user, developer -->` を付けると、対象読者を指定できます。指定できる値は `user`、`developer`、`maintainer` です。タグのないページは全読者向けです。`--manual build --root . --audience developer` は対象ページだけを `manual/developer/` に出力します。`--audience user` と `--audience maintainer` も同様です。読者別出力には、その読者向けの `index.md` が必要です。
