# Tasks: PyCharm Plugin Integration

- [x] 1. Rust CLI (`analyze.rs`) の `--json` オプション対応 <!-- id: 1 -->
  - `--json` 引数が渡された場合に標準出力へ `serde_json::to_string` を出力するよう修正
  - 単体テスト・CLI 動作検証

- [x] 2. PyCharm プラグインの Web アセット作成 <!-- id: 2 -->
  - JCEF 用の自己完結型 HTML/JS/CSS（Cytoscape.js + Dagre）を `plugins/pycharm/src/main/resources/web/` に整備
  - `window.renderModuleGraph(data)` による動的データ受取インターフェース
  - `window.pycharmJumpToFile(path, line)` による PyCharm コールバック呼び出し

- [x] 3. PyCharm プラグイン (Java/IntelliJ Platform) の実装 <!-- id: 3 -->
  - `plugins/pycharm/src/main/java/com/pymodulemgr/PyModuleMgrToolWindowFactory.java`
  - JCEF ブラウザ組み込み、`JBCefJSQuery` によるエディタジャンプの実装
  - プロジェクトパスの取得と Rust CLI (`analyze --json`) のバックグラウンド実行
  - `META-INF/plugin.xml` の定義 (ToolWindow 拡張)

- [x] 4. プラグインのビルドスクリプトと自動配置 <!-- id: 4 -->
  - JBR の `javac` と PyCharm の `lib/*.jar` を用いたビルドスクリプト `build_plugin.py` の作成
  - プラグイン JAR `pymodulemgr-pycharm.jar` の生成
  - `~/.local/share/JetBrains/PyCharm2026.2/` および `PyCharm2025.3/` への自動インストール

- [x] 5. 動作検証と動作確認 <!-- id: 5 -->
  - プラグインの JAR パッケージ検証
  - CLI `--json` の動作確認
  - PyCharm からの認識と Tool Window の表示確認
