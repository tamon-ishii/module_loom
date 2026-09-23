# ModuleLoom 不具合調査 引き継ぎ

## 引き継ぎ時の状況

- 作業ディレクトリ: `/home/ishii/PycharmProjects/pymodulemgr`
- ブランチ: `main`（`origin/main` と同じ位置）
- HEAD: `c84ac49 Improve MkDocs API documentation and offline support`
- 変更はすべて未コミット。作業ツリーに複数の変更・削除・追加ファイルがあるため、調査前に `git status` と diff を確認すること。変更を破棄しない。
- ユーザーの訴え: 「まったくバグがなおらん」。症状・再現手順・対象製品（Desktop / PyCharm / VS Code）はこの引き継ぎ作成時点で特定できていない。最初にユーザーへ、直したい具体的な症状と再現手順、対象環境を確認すること。

## 変更の大枠

今回の未コミット差分は、単一の修正ではなく複数の変更を含む。

1. 共通の Web UI (`index.html`, `src/main.ts`, `src/style.css`) を Vite でビルドし、PyCharm と VS Code に同じ `dist/` をコピーする方式へ変更。
2. HTML の操作領域を整理し、「その他の操作・絞り込み」を折りたたみ領域へ移動。
3. PyCharm Java 側の WebView/JCEF 連携を変更し、Web UI からのコマンド実行、解析、ファイルを開く処理、循環修正プレビュー/適用などを追加・組み替え。
4. VS Code 拡張に Activity Bar コンテナとランチャービューを追加し、拡張側のコマンド処理も変更。
5. 古い同梱 JS (`cycle-insights.js`, `cytoscape*.js`) を削除し、ビルド済み `assets/` を配置。
6. ビルドスクリプトと GitHub Actions に npm ビルドを追加。

差分の主な確認対象:

- 共通 UI: `src/main.ts`, `src/style.css`, `index.html`, `vite.config.ts`
- PyCharm: `plugins/pycharm/src/main/java/com/moduleloom/ModuleLoomToolWindowFactory.java`, `scripts/build_pycharm_plugin.py`
- VS Code: `plugins/vscode/extension.js`, `plugins/vscode/package.json`, `scripts/build_vscode_extension.py`, `scripts/package_vscode_extension.py`
- 生成物: `plugins/pycharm/src/main/resources/web/`, `plugins/vscode/media/`
- CI: `.github/workflows/build-and-release.yml`, `.github/workflows/publish-pycharm-marketplace.yml`

## 調査で注意する点

- 症状が不明なまま、今回の大きな差分全体を「修正済み」と扱わない。まず UI のどの操作で、どのホスト上で、何が起きるかを一つに絞って再現する。
- PyCharm Java の変更には、JCEF のロード時イベント、`cefQuery` ブリッジ、初回解析の起動、コマンド応答の JSON が絡む。Web UI 側の `invokeCommand` / `__MODULELOOM_*` 呼び出しと、ホスト側が返す JSON の形を対にして追う。
- Vite の `base: "./"` により、バンドル JS/CSS の相対 URL は埋め込み先で使える想定。PyCharm の `prepareWebAssets(...)` と VS Code の Webview HTML 生成で、相対パス・CSP・ローカルリソース許可が一致しているか実機で確認する。
- `plugins/*/README.md` には現状と一致しない記述が残っている可能性がある（例: PyCharm の「再解析」「MkDocs 出力」「自動更新」の記述と、今回のツールバー変更）。ドキュメントだけから動作を判断しない。
- 生成物の削除と再生成が差分に含まれる。生成物がソースと同期しているか、ビルドスクリプトが期待する出力先・実行環境を確認する。
- 問題の症状と再現確認なしに、ビルドやテストを「通ったから修正完了」と結論づけない。

## 次にやること

1. ユーザーに対象（Desktop / PyCharm / VS Code）、期待動作、実際の動作、再現操作、ログ/エラーを聞く。
2. `git diff --check` と該当箇所の差分を確認し、既存のユーザー変更を保護する。
3. 症状に沿って最小の再現経路を追う。必要なら対象 IDE のログ/開発者コンソールと解析器の標準出力を確認する。
4. 原因を特定してから、症状に対応する最小修正を行い、同じ再現手順で確認する。ユーザーが依頼していない無関係な整形・リファクタリングは混ぜない。
5. 引き継ぎ後の変更・確認結果・残る再現条件をこの文書へ追記する。

## コマンド

```sh
git status --short --branch
git diff --check
npm run build
```

`npm run build` は TypeScript の型チェックと Vite ビルドを行う。ホスト拡張の実動作確認には、各拡張のパッケージを作成して対象 IDE で開く必要がある。

## 実施した対応履歴

### 1. PyCharm プラグインでの「ジャンプ先:」表示および行消費の解消
- **症状**: PyCharm ツールウィンドウ内で「ジャンプ先:」選択肢（`.editor-select-area`）が表示され、メディアクエリ（幅700px以下で `grid-column: 1 / -1`）によってヘッダーをまるまる1行消費していた。
- **原因**:
  - CSS (`src/style.css`) の `.editor-select-area` に `display: flex;` が指定されており、HTMLの `hidden` 属性による UA スタイル（`display: none`）が CSS 詳細度によって上書きされていた（`[hidden] { display: none !important; }` が存在しなかった）。
  - PyCharm/VS Code ホスト環境下で `.editor-select-area` を完全に DOM から削除していなかった。
- **修正内容**:
  - `src/style.css`: 基本規則に `[hidden] { display: none !important; }` および `.editor-select-area[hidden] { display: none !important; }` を追加。
  - `src/main.ts`: ホストエディタ環境（`hostEditor === "pycharm" || hostEditor === "vscode"`）で `.editor-select-area` を DOM から削除（`.remove()`）。
  - `ModuleLoomToolWindowFactory.java` & `plugins/vscode/extension.js`: 初期レンダリング時のチラつき防止のため、インライン `<style>.editor-select-area{display:none !important;}</style>` を注入。
  - `scripts/build_pycharm_plugin.py` / `scripts/build_vscode_extension.py` を実行し、生成物およびインストール先 jar を更新済み。

### 2. 「プロジェクトパス、解析対象、解析実行」1行化および解析不動作の解決
- **症状**:
  - PyCharm プラグインツールウィンドウで「解析対象:」コンボボックスだけが配置され、プロジェクトパス入力や解析実行ボタンが欠落または別扱いになっていた。
  - PyCharm プラグイン上で解析が一切実行されない（グラフが描画されず、画面が反応しない）。
- **原因**:
  - **最大要因**: `ModuleLoomToolWindowFactory.java` の JCEF `jsQuery.inject("arg.request")` の呼び出しにおいて、第2・第3引数のコールバック（`onSuccess`, `onFailure`）が渡されていなかったため、`JBCefJSQuery` がデフォルトの空コールバック `function(response) {}` を生成していた。その結果、Web UI 側の `window.__MODULELOOM_INVOKE__` の Promise の `resolve` が永久に呼ばれず、`runAnalysis()` の非同期処理が完全に停止していた。
  - **ツールバー配置**: Swing の `toolbarPanel` にプロジェクトパス入力欄と解析実行ボタンが存在せず、Web UI 側では非表示化されていたため、ユーザーがパスの指定や明示的な解析実行を行えなかった。
- **修正内容**:
  - `ModuleLoomToolWindowFactory.java`:
    - `jsQuery.inject("arg.request", "arg.onSuccess", "arg.onFailure")` に修正し、Java からの応答が JavaScript 側の Promise を正しく resolve/reject するよう修正。
    - Swing の `toolbarPanel` に「プロジェクトパス:」テキストフィールド、「解析対象:」コンボボックス、「解析実行」ボタン、「ダブルクリック連動」チェックボックスを横1行で配置。
    - 「解析実行」ボタン押下時およびコンボボックス変更時に、指定パスで即座に解析が実行され Web UI 側に反映されるよう連携。
    - `runAnalyze` および `onLoadEnd` から Web UI 側の `window.__MODULELOOM_REANALYZE__()` を直接確実にトリガーするよう改善。
  - `scripts/build_pycharm_plugin.py` を実行し、JAR を再生成してローカルの PyCharm 環境へ配備済み。

### 3. 解析実行時の JSON パースエラー・排他ロックデッドロックの修正および自動更新チェックボックス追加
- **症状**:
  - 「解析実行」ボタンを押しても解析が実行されない。
  - 「自動更新」チェックボックスがツールバーにない。
- **原因**:
  - **JSON 破損**: `ModuleLoomToolWindowFactory.java` の `runProcess` で `redirectErrorStream(true)` になっていたため、Rust の `analyze` コマンドが `stderr` に出力した警告メッセージ（例: `Warning: Failed to parse ...`）が標準出力の JSON の先頭に混入し、JavaScript 側の `JSON.parse(raw)` で構文エラー（SyntaxError）が発生して解析が失敗していた。
  - **排他ロック**: `runAnalyze` で `holder.analysisRunning = true;` に設定後、Web UI へ `executeJavaScript` して抜けるパスで `holder.analysisRunning = false;` に戻していなかったため、2回目以降の「解析実行」ボタンクリックがすべてスキップされていた。
- **修正内容**:
  - `runProcess`: `redirectErrorStream(false)` に設定し、標準出力（stdout）と標準エラー出力（stderr）を明確に分離。エラー時のみ stderr を例外メッセージに含めるように変更。
  - `analyze_project`: 返された文字列から最初に出現する `{` と末尾の `}` の間を抽出し、確実に純粋な JSON のみを返すガードを追加。
  - ツールバー: `chkDoubleClickSync`（ダブルクリック連動）の横に `chkAutoRefresh`（自動更新）チェックボックスを配置し、リスナーで `holder.autoRefresh` と `refreshTimer` を連動。
  - `scripts/build_pycharm_plugin.py`: ビルド時に `~/.cache/moduleloom/web` を自動削除し、常に最新の Web アセットが PyCharm にロードされるように改善。

### 4. Chromium/JCEF における file:// スキームの ES Module CORS ブロック解消（解析実行不動作の根本原因）
- **症状**:
  - PyCharm プラグインの「解析実行」ボタンを押しても何も起きない（ステータスバーが更新されず、グラフも描画されない）。
- **原因**:
  - **最大根本原因（CORS ブロック）**: Vite によるビルド成果物が `<script type="module" crossorigin src="./assets/index.js">` かつ複数チャンク（`cytoscape.js` 等への ES Module `import`）となっていた。Chromium / JCEF は `file:///` スキーム上のローカル HTML からの `<script type="module">` および ES Module の読み込みを CORS ポリシー（Origin: `null`）により `ERR_FAILED (CorsDisabledScheme)` として**すべてブロック**していた。
  - そのため、Web UI 側の JavaScript（`index.js` 等）が一切ロード・実行されず、`window.__MODULELOOM_REANALYZE__` も `undefined` のままで、ツールバーの「解析実行」ボタンを押しても JavaScript が何も応答していなかった。
  - **Analyzer 同梱更新漏れ**: `scripts/build_pycharm_plugin.py` の `stage_local_analyzer` で `if os.path.isfile(destination): return` となっていたため、最新の Rust バイナリが JAR に同梱されず、古いバイナリが使われ続けていた。
  - **EDT 未委譲**: `performAnalyze` での `executeJavaScript` 呼び出しがバックグラウンドスレッドから直接行われていた。
- **修正内容**:
  - `vite.config.ts`:
    - `format: "iife"`, `inlineDynamicImports: true`, `name: "ModuleLoomApp"` を指定し、外部ライブラリを含む全フロントエンドコードを完全な単一の IIFE スクリプト（`assets/index.js`）としてバンドル。
    - Vite プラグインを追加し、HTML 生成時に `<script type="module" crossorigin>` を `<script defer>` に自動変換。
  - `ModuleLoomToolWindowFactory.java`:
    - `prepareWebAssets`: コピー対象を単一化されたアセット群（`index.html`, `assets/index.js`, `assets/index.css`）に更新し、HTML 内の `<script type="module"` を `<script defer` に置換するガードを追加。
    - `performAnalyze` & `onLoadEnd`: `executeJavaScript` の呼び出しを EDT (`ApplicationManager.getApplication().invokeLater`) に委譲し、Web 側のスクリプト初期化が完了するまで確実にリトライして `runAnalysis()` を呼び出す堅牢なトリガーを実装。
    - `browser`: JCEF のコンソール出力を PyCharm ログへ流す `CefDisplayHandler` を追加。
  - `scripts/build_pycharm_plugin.py`:
    - `stage_local_analyzer` で常に最新の `target/release/analyze` または `target/debug/analyze` を JAR 同梱先へ反映するように改善。
  - プラグイン JAR を再ビルドし、ローカルの PyCharm 環境（`~/.local/share/JetBrains/PyCharm*`）へ配備完了。

### 5. 2行目の重複要素（プロジェクトパス・解析実行）の削除および全体レイアウト見直し・重複ボタン排除
- **要望**:
  - 1行目にプロジェクトパスと解析実行があるため、2行目のものは削除。
  - レイアウトを全体的に見直し。
  - 重複しているボタンなどを排除。
- **実施内容**:
  - **2行目重複要素の完全非表示化**:
    - Web UI 側の `#project-path-input`（プロジェクトパス入力）および `#btn-analyze`（解析実行ボタン）を HTML および CSS で `display: none !important;` に設定。
    - `ModuleLoomToolWindowFactory.java` の JCEF 初期化時 bootstrap CSS にも追加し、初期レンダリング時から確実に消去。
  - **重複ボタン・コントロールの排除**:
    - **ズームボタンの重複排除**: ヘッダー側の `.zoom-btn-group`（`#btn-header-zoom-out`, `#btn-header-zoom-in`）を削除。グラフキャンバス右下のフローティングコントロール（`+`, `−`, `1:1`, `⤢`）へ一本化。
    - **自動更新チェックボックスの重複排除**: 1行目（Swing Native ツールバー）に「自動更新」チェックボックスがあるため、Web UI 側の `.watch-toggle-label`（`#chk-watch`）を非表示化。
    - **エディタジャンプ先選択の排除**: `.editor-select-area` を非表示化。
  - **2行目ヘッダーレイアウトの最適化**:
    - これまで折りたたみ（`advanced-controls`）内に埋もれていた `#search-input`（モジュール検索）をヘッダーのメインバー（`.search-box-header`）に昇格配置。
    - ヘッダーを `[← 戻る] [🌐 全体図] [📁 ツリー] [全体表示] [🔍 モジュール検索...] [その他の操作・絞り込み ▼]` の美しい 1 行構成に整理。
    - `details.advanced-controls` はポップオーバー風のドロップダウンに変更し、折りたたみ時も展開時もヘッダー領域が複数段に渡ってグラフ領域を圧迫しないように改善。
  - ビルドおよびローカル PyCharm への配備を完了。

### 6. ソースツリーヘッダーの不要な操作ボタン（−, ＋, ×）の削除
- **要望**: ソースツリーの-+xは不要。
- **原因・背景**: ソースツリー（`#tree-panel`）のヘッダーに配置されていた「すべて折りたたむ（−）」「すべて展開（＋）」「閉じる（×）」ボタン（`.panel-actions`）は、ヘッダー上の「📁 ツリー」ボタンで開閉可能であることや、ノードごとの個別トグルで十分であるため冗長となっていた。
- **実施内容**:
  - `index.html`: `#tree-panel` の `.panel-header` 内にあった `.panel-actions`（`#btn-tree-collapse-all`, `#btn-tree-expand-all`, `#btn-close-tree`）を削除。
  - `src/main.ts`: 削除したボタン要素の参照、リスナー登録、および使用されなくなった `collapseAllTree` / `expandAllTree` 関数を整理・削除。
  - `npm run build`、`scripts/build_vscode_extension.py`、`scripts/build_pycharm_plugin.py` を実行して Web アセットおよびプラグイン成果物を再ビルド・再配備完了。

### 7. 縦横表示切り替えボタン（#btn-flow-direction）を「全体表示」直後へ移動
- **要望**: 縦横表示を全体表示の後ろに移動。
- **実施内容**:
  - `index.html`: `details.advanced-controls` の内部にあった `#btn-flow-direction`（「↔ 横表示 / ↕ 縦表示」切り替えボタン）を、ヘッダーメインツールバーの `#btn-fit`（全体表示）直後へ移動。
  - ヘッダー配置: `[← 戻る] [🌐 全体図] [📁 ツリー] [全体表示] [↔ 横表示] [🔍 モジュール検索...] [その他の操作・絞り込み ▼]`
  - Web アセットおよび PyCharm / VS Code 拡張を再ビルドし、環境へ反映完了。

### 8. 詳細パネルの「🎯 このモジュールの依存図を表示」ボタンの削除
- **要望**: 「このモジュールの依存図を表示ボタンは不要だと思うがどうか？」→ 同意の上で削除実施。
- **背景**:
  - ツリーでのファイル選択時やインスペクター内リンクのクリック時に自動でそのモジュールの依存図へジャンプしており、すでに表示されている状態で常時最上部に同一図描画ボタンが居座り冗長となっていた。
  - 全体図からの個別依存図遷移もノードのダブルクリックで可能。
- **実施内容**:
  - `src/main.ts`: インスペクター上部の `#btn-show-this-dep` ボタンおよびそのクリックイベントリスナーを削除。
  - 残った「📊 ポップアップ図で表示」ボタンを横幅 100% のすっきりしたボタンに調整。
  - 依存図外選択時のガイドテキストから「下のボタンまたは」を削除。
  - Web アセットおよび PyCharm / VS Code 拡張を再ビルド・再配備完了。

### 9. 詳細パネル上部の重複した「⚠️ トップレベルの循環インポート」警告枠の削除
- **要望**: 循環インポート検出が２つ重複している。
- **原因**: モジュール詳細（インスペクター）内で、上部に赤枠の単純な警告ボックス（`cycleAlertHtml`）と、下部に代表経路・改善候補・強調表示ボタンを備えた「🔄 循環インポート検出」カード（`cycle-card`）の両方が表示され、同じ循環情報が重複して報告されていた。
- **実施内容**:
  - `src/main.ts`: インスペクター上部の `cycleAlertHtml` の宣言およびテンプレート埋め込みを削除。
  - 下部のリッチな可視化カード「🔄 循環インポート検出」（`.cycle-card`）へ一本化。
  - Web アセットおよび PyCharm / VS Code 拡張を再ビルド・再配備完了。

### 10. モジュール詳細パネルの整理・改善（リンク化・ミニフロー/docstring削除・パネル開閉ボタン追加）
- **要望**:
  1. PyCharmで開くボタンは不要、モジュール名をハイパーリンクに。
  2. モジュール詳細の利用元→指定→利用元の図は不要。
  3. モジュール詳細のdocstringは削除。
  4. ツリーのようにモジュールボタンで表示/非表示を設定。
- **実施内容**:
  - `src/main.ts`:
    - `<h2>` 内のモジュール名をエディタジャンプリンク（`.module-title-link`）に変更し、クリックで `jumpToEditor(mod.absolute_path, 1)` を実行するよう実装。
    - 「PyCharm/VS Code で開く」ボタン（`#btn-jump-code`）を削除。
    - 依存ダイアグラムミニフローカード（`dep-flow-card`）および `docstring` セクションを削除。
    - `toggleInspectorPanel(forceState?: boolean)` を実装。モジュール選択時に自動で開き、`#btn-close-inspector`（×ボタン）で閉じるように連動。
  - `index.html`: ヘッダーバーの「📁 ツリー」の横に `<button id="btn-toggle-inspector">📄 モジュール</button>` を追加。
  - `src/style.css`: `.inspector-panel.collapsed`（`display: none;`）および `.module-title-link` のスタイルを追加。
  - Web アセット、VS Code 拡張、PyCharm プラグインを再ビルドし、環境へ配備完了。

### 11. 問題・エラー一覧ポップアップの実装と各操作ボタンのJCEF/WebView対応（Git差分・履歴差分・レポート出力・MkDocs出力）
- **要望**:
  1. 検索ボタンをつけて、依存宣言の問題、未使用シンボル候補、アーキテクチャルール違反のモジュール一覧などエラー系のものをポップアップで表示し、各問題ごとにフィルタリングできるようにする。
  2. Git差分、履歴差分、レポート出力、MkDocs出力などのボタンが利かない問題を修正する。
- **原因・背景**:
  - **ボタンが利かなかった根本原因**:
    - `highlightGitHistory` / `exportMkDocs`: Chromium / JCEF（PyCharm WebView）および VS Code Webview ではセキュアコンテキスト制限やダイアログハンドラ未実装により `window.prompt` / `window.confirm` がサポートされておらず、呼び出した瞬間に `null` / `false` が返り処理が中断されていた。
    - `exportReport`: ブラウザの `<a download>` によるファイルダウンロードは JCEF 組み込みブラウザ環境ではダウンロードマネージャが存在せず無反応となっていた。
    - `highlightGitChanges`: JCEF 環境で非表示となった `#project-path-input` からのパス取得が空になり、またパス区切り文字（`\` vs `/`）の正規化の不一致により変更差分が一致しない場合があった。
- **実施内容**:
  - **問題・エラー一覧モーダル（#issues-modal）の実装**:
    - `index.html`: ヘッダーの検索欄の横に `<button id="btn-search-issues">⚠️ 問題一覧</button>` を追加。モーダル内に「すべて」「🔄 循環」「🏛 アーキテクチャ」「📦 依存宣言」「🧹 未使用シンボル」「⚠️ 肥大化」「🩺 診断/型」のカテゴリ別フィルタタブとキーワード検索バーを配置。
    - `src/main.ts`:
      - `collectAllIssues()`: プロジェクト内のすべての問題（循環インポート、アーキテクチャ違反、依存宣言の問題、未使用シンボル候補、肥大化モジュール、診断エラー・警告）を横断収集。
      - `openIssuesModal()` / `renderIssuesList()`: 各カテゴリの件数バッジ付きタブで瞬時にフィルタリング可能。カードをクリックするとそのモジュールの依存図へ直接フォーカス。
      - 検索欄（`#search-input`）で Enter キーを押した際にも入力ワードを引き継いで問題一覧モーダルを開くよう連携。
  - **Git差分 / 履歴差分 / レポート出力 / MkDocs出力の JCEF / WebView 動作保証**:
    - **Git差分（#btn-git-diff）**: プロジェクトルートのパス解決を堅牢化し、差分が 0 件の場合も「該当する変更 Python ファイルはありません（最新の状態です）」とステータスバーに明示通知。
    - **コミット履歴差分（#git-history-modal）**: `window.prompt` を廃止し、比較元（base: `HEAD~1`）と比較先（head: `HEAD`）を入力・選択できる HTML モーダルを新設。
    - **レポート出力（export_report）**:
      - `plugins/pycharm/src/main/java/com/moduleloom/ModuleLoomToolWindowFactory.java`: JCEF ホスト側 IPC に `export_report` コマンドを追加。プロジェクト直下の `.moduleloom/moduleloom-report-<timestamp>.html` および `*.json` に直接保存し、OS のファイルエクスプローラー/Finder で該当フォルダを開く処理を実装。
      - `plugins/vscode/extension.js`: 同様に `export_report` コマンドをサポート。
      - ブラウザ単体プレビュー時のための `<a download>` フォールバックも保持。
    - **MkDocs ドキュメント生成（#mkdocs-modal）**: `window.prompt` を廃止し、出力先ディレクトリパスおよびドキュメント言語（auto / ja / en）を選択できる HTML モーダルを新設。
  - Web アセット（`npm run build`）、VS Code 拡張（`scripts/build_vscode_extension.py`）、PyCharm プラグイン（`scripts/build_pycharm_plugin.py`）をビルド・全 PyCharm 環境へ配備完了。

### 12. ヘッダーの「全体表示」ボタン削除および「縦横切り替え」ボタンのキャンバス内フローティング操作パネルへの統合
- **要望**:
  1. 全体表示ボタンは不要（グラフ上のポップアップ/フローティングコントロールに同様のボタンがあるため）。
  2. 縦横の切り替えもグラフ上のポップアップ/フローティングコントロールに統合して、ヘッダーのボタンを削除。
- **実施内容**:
  - **ヘッダーコントロールの整理**:
    - `index.html`: ヘッダーツールバーから `#btn-fit`（全体表示）および `#btn-flow-direction`（↔ 横表示 / ↕ 縦表示）を削除。
    - これによりヘッダーは `[← 戻る] [🌐 全体図] [📁 ツリー] [📄 モジュール] [🔍 モジュール検索... [⚠️ 問題一覧]] [その他の操作・絞り込み ▼]` となり、主要ナビゲーションと検索・問題検出に集中した非常にスッキリしたデザインに最適化。
  - **グラフ上のフローティングパネルへの統合**:
    - `index.html`: グラフ右下の `.floating-zoom-controls` に `<button id="btn-float-flow-direction" class="btn-float" title="フロー方向の切り替え (横 ↔ 縦)">↔</button>` を追加。
    - `src/main.ts`:
      - フロー方向（`LR` / `TB`）に応じてボタンの表示記号（`↔` / `↕`）およびツールチップ（`フロー方向: 横 (LR) - クリックで縦に切り替え` など）を更新。
      - クリック時に即座にレイアウトを再計算・再描画する処理をバインド。
  - Web アセット（`npm run build`）、VS Code 拡張（`scripts/build_vscode_extension.py`）、PyCharm プラグイン（`scripts/build_pycharm_plugin.py`）をビルド・全 PyCharm 環境へ配備完了。

### 13. モジュール詳細パネルから「📊 ポップアップ図で表示」ボタンの完全削除およびビルド・再配備
- **要望**: 「モジュール詳細のポップアップ図で表示おボタンいらん」
- **対応内容**:
  - モジュール詳細（インスペクター）上部に表示されていた「📊 ポップアップ図で表示」ボタン（`#btn-open-dep-dialog`）および関連するモーダル図処理を完全削除。
  - 最新の Web アセット（`npm run build`）、VS Code 拡張（`scripts/build_vscode_extension.py`）、および PyCharm プラグイン（`scripts/build_pycharm_plugin.py`）をビルド。
  - ローカルの PyCharm 環境（2025.3, 2026.2, 2026.3）へ最新の `moduleloom.jar` を再配備完了。PyCharm の再起動により最新の画面が反映されます。

### 14. モジュール詳細の問題関連項目の削除およびインポートアイテムクリック時のコード行ジャンプ
- **要望**:
  1. モジュール詳細の問題関連の項目はいらない。
  2. インポートリストのアイテムをクリックしたら、インポートしている行にジャンプしてほしい。
- **対応内容**:
  - **問題関連項目の削除**:
    - モジュール詳細（インスペクター）から「🔍 問題一覧で検索」ボタン、ならびに下部に配置されていた「🏛 アーキテクチャルール違反」「📦 依存宣言の問題」「🧹 未使用シンボル候補」セクションを削除。問題検出・診断はヘッダーバーの「⚠️ 問題一覧」モーダルへ一本化。
  - **インポートリストアイテムのコード行ジャンプ**:
    - 「📤 インポート (利用先)」「🌐 外部 / 未解決 import」「📥 被インポート (利用元)」の各アイテム行（`.dep-item`）全体に `cursor: pointer` と行ジャンプ属性（`data-jump-file`, `data-jump-line`）を設定。
    - クリック時にエディタ（PyCharm / VS Code）でそのモジュールを import している該当行へ直接ジャンプするよう改善。
    - ダブルクリック時はそのモジュールの依存図へフォーカス切り替え（`jumpToFileCentricDiagram`）を保持。
  - `npm run build`、`scripts/build_vscode_extension.py`、`scripts/build_pycharm_plugin.py` を実行して再ビルド・全 PyCharm 環境へ配備完了。

### 15. モジュール詳細の循環インポート検出カードへの「ツールによる循環インポート解消」ボタン追加
- **要望**: 「モジュール詳細で循環インポート検出で、ツールによる循環インポート解消ボタンを追加して」
- **対応内容**:
  - **ボタン配置**:
    - モジュール詳細（インスペクター）の「🔄 循環インポート検出」カードヘッダー（`cycle-card-header`）および各循環経路行（`cycle-flow-row`）の操作エリアに「🛠️ ツールによる循環インポート解消」ボタン（`.btn-cycle-resolve`）を追加。
  - **動作仕様**:
    - 対象の循環候補が選択中のツール（Ruff TC001 等）で自動解消可能な場合（型注釈のみの参照 `type_only` 等）:
      - ボタンがアクティブ（緑色アクセント）で表示され、クリック時に `previewRuffCycleFix(source, line)` を起動。
      - 外部ツールの修正差分モーダルが表示され、ユーザーが差分を確認して「差分を適用」をクリックすることで、該当 Python ファイルの修正（`TYPE_CHECKING` ブロックへの自動分離等）と再解析が実行され、循環インポートが解消されます。
    - 実行時参照（`runtime`）などツールの自動修復に対応していない循環の場合:
      - ボタンはグレーアウト（`.disabled`）され、ツールチップで理由を表示。
      - クリック時にはステータスバーおよび分かりやすいダイアログで「なぜ自動解消できないか（実行時参照）」と、3つの具体的な対処法（関数内遅延インポートへの変更、共通モジュールへの定義抽出、依存方向の見直し）を丁寧に案内。
  - **スタイル・レイアウト**:
    - `src/style.css`: `.btn-cycle-resolve`（成功色グリーン系）、ホバー効果、無効状態、ならびに各循環行のボタン横並び用 `.cycle-row-actions` を追加。循環フローコンテナの最大高さを拡張。
  - **ビルド・配備**:
    - `npm run build`、`scripts/build_vscode_extension.py`、`scripts/build_pycharm_plugin.py` を実行して再ビルド。ローカルの PyCharm 環境（2025.3, 2026.2, 2026.3）へ最新 JAR を配備完了。

### 16. 「ツールによる循環インポートの解消」ボタンが効かない問題の根本修正と解消アシスタントモーダルの実装
- **要望**: 「ツールによる循環インポートの解消ボタンが効かない」
- **原因・背景**:
  1. **最大要因（ダイアログ不動作）**: 実行時参照（`runtime`）や対象ツール非対応の循環候補に対して、`handleCycleResolveClick` 内で `alert(...)` を呼んでいた。しかし Chromium / JCEF（PyCharm WebView）および VS Code Webview では `window.alert` がハンドラ未登録により無視されるため、ダイアログが一切出ず、画面上は「ボタンを押しても何も起きない（無反応）」状態になっていた。
  2. **Analyzer同梱の更新漏れ**: `scripts/build_pycharm_plugin.py` の `stage_local_analyzer` が古い `target/release/analyze`（9/23ビルド）を優先同梱しており、`cycle.suggestion` が `null` になっていた。その結果、すべての循環インポートで `canFix` が `false` に固定され、自動解消ツールが全く起動できなかった。
  3. **ボタンのUXと状態**: `canFix` が false の循環でボタンが `.disabled` でグレーアウトしつつ押しても無反応だったため、「壊れている」「どう直せばよいか分からない」状態になっていた。また差分未提示時もステータスバー表示のみでモーダルが出ず無反応に見えていた。
  4. **ホスト側 IPC の脆弱性**: `ModuleLoomToolWindowFactory.java` の `preview_cycle_fix` で `suggestion` の正規表現パースが失敗しやすく、ファイルの絶対パス解決も相対パス時に CWD 基準で失敗するリスクがあった。また `ruffExecutable` の探索パスも狭かった。
- **実施内容**:
  - **「循環インポート解消アシスタント」モーダル（#cycle-guide-modal）の新設**:
    - `index.html` & `src/main.ts`: `alert()` を完全撤廃。自動解消ツールが対応できない循環（実行時参照 `runtime` など）やツール差分未提示時、ボタンクリックで専用の美しい解消アシスタントモーダルを起動。
    - モーダル内に「循環インポートループ」「対象モジュール・行番号」「なぜ外部ツール（Ruff等）で自動解消できないかの詳細理由（実行時参照であるため）」「3つの安全な解消アプローチ（① 関数内遅延インポートへの変更、② 共通モジュールへの定義抽出、③ 依存性の注入）の解説と Python コード例」を表示。
    - モーダル下部に「📝 エディタで該当コード行を開く」ボタンを配置し、PyCharm / VS Code のエディタで対象ファイルの該当 import 行をワンクリックで直接開けるよう実装。
  - **ボタンの表示と UX 改善**:
    - `canFix === true`（型注釈等で自動解消可能）: `🛠️ [ツール名] で自動解消`（緑色アクセント）
    - `canFix === false`（実行時参照・ガイド対象）: `🛠️ 循環インポート解消ガイド`（青/水色系 `.guide-mode`）
    - どちらをクリックしても適切なモーダル（自動修正差分プレビュー または 解消アシスタント）が確実に起動し、「ボタンが効かない」状態を完全に解消。
  - **Analyzer バイナリ更新とビルド改善**:
    - `cargo build --release` を実行し、`path` と `suggestion` を出力する最新バイナリを生成。
    - `scripts/build_pycharm_plugin.py`: `stage_local_analyzer()` で `candidates` のうち mtime（更新日時）が新しいバイナリを自動選択して同梱するように改善。
  - **ホスト側 IPC（Java / VS Code）の堅牢化**:
    - `ModuleLoomToolWindowFactory.java` & `plugins/vscode/extension.js`: `preview_cycle_fix` で Web UI から直接渡された `target`, `line`, `kind` をフォールバック利用可能に改善。
    - モジュールファイルのパス解決を `root.resolve(...)` を経由して相対パスでも確実に解決。
    - `ruffExecutable`: 親ディレクトリの `.venv` や `~/.local/bin/ruff`, `~/.cargo/bin/ruff` を探索対象に追加。
  - **ビルド・全 PyCharm 環境へ配備**:
    - `npm run build`、`scripts/build_vscode_extension.py`、`scripts/build_pycharm_plugin.py` を実行して再ビルド。
    - ローカルの PyCharm（2025.3, 2026.2, 2026.3）へ最新 JAR を配備完了。
