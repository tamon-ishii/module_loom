## Context

See `proposal.md` for motivation and system scope.
本設計では、Python コードベースの静的解析エンジンを Rust で構築し、Tauri による軽量デスクトップアプリケーションとして Graph-It-Live スタイルのインタラクティブな依存関係グラフと診断機能を提供します。エディタ内蔵は行わず、コード編集・ジャンプは PyCharm や VS Code などの外部ツールに委譲します。

## Goals / Non-Goals

**Goals:**
- Rust によるミリ秒オーダーでの Python AST パースと依存関係グラフの構築
- 強連結成分分解（Tarjan 等のアルゴリズム）による循環インポートの完全検出
- モジュール行数 (LOC)、シンボル数、結合度等のモジュール肥大化メトリクス計算
- 型チェック結果（型アノテーションの有無や型エラー診断）の統合
- Graph-It-Live に類似した、直感的でズーム・パン・フィルタリングが滑らかなグラフ描画
- PyCharm（`jetbrains://` URL または CLI）および VS Code（`vscode://` URL または `code --goto`）へのシームレスなコードジャンプ

**Non-Goals:**
- 自前のコードエディタの実装（コード表示や編集は PyCharm / VS Code を使用）
- 実行時のみ決定される動的インポート（`importlib.import_module(var)` 等）の完全なエミュレーション（静的に特定可能な範囲に留め、動的インポートは未解決参照として表示）
- 完全な型推論エンジンのゼロからの再実装（既存の型アノテーション抽出、および `ty` / `mypy` / `pyright` の診断結果取り込みを活用）

## Decisions

### 1. 解析エンジン: Rust + 高速 AST パーサー
- **Rationale**: Python の標準 `ast` に比べ、Rust（Tree-sitter または Ruff のパーサークレート等）を使用することで数千ファイルの解析がミリ秒単位で完了し、リアルタイムなグラフ更新が可能になります。
- **Alternatives considered**:
  - Python ネイティブ解析: 実装は容易だが、大規模プロジェクトで UI 応答性やリアルタイム更新が損なわれる。
  - TypeScript/Node.js: Tree-sitter バインディングはあるが、Tauri の Rust バックエンドとの親和性と並行処理性能で Rust が勝る。

### 2. GUI フレームワーク: Tauri (Rust + Web フロントエンド)
- **Rationale**: Electron に比べてバイナリサイズが極めて小さく、メモリ消費が少ない。また、Rust 解析エンジンを Tauri の `invoke` コマンドとしてインプロセスで直接呼び出せるため、プロセス間通信のオーバーヘッドを最小化できます。
- **Alternatives considered**:
  - Electron: 開発は容易だがリソース消費が大きい。
  - PyQt / PySide: Python との親和性はあるが、モダンなインタラクティブグラフライブラリ（Canvas/WebGL）の統合が複雑になる。

### 3. グラフレンダリング: Canvas / WebGL ベースの 2D グラフエンジン
- **Rationale**: 大規模プロジェクト（数百〜数千ノード）でも 60fps を維持するため、Canvas / WebGL ベース（Force-Graph, Cytoscape.js, Pixi.js 等）を採用します。
- **Alternatives considered**:
  - 純粋な SVG（D3.js SVG 等）: 小規模では綺麗だが、ノード数が増えると DOM 数過多により著しく動作が重くなる。

### 4. 外部エディタ連携: URL スキーム優先 + CLI コマンドフォールバック
- **Rationale**: ユーザーの手間（プラグイン個別インストール）を減らすため、PyCharm の `jetbrains://pycharm/navigate/reference?project=...&path=...:line` や VS Code の `vscode://file/...:line` URL スキームを使用します。URL スキームが利用できない環境では、`pycharm --line` や `code -g` などの CLI 実行へフォールバックします。
- **Alternatives considered**:
  - 専用 IDE プラグインの開発: PyCharm 向けプラグインと VS Code 向け機能拡張の両方を別々に開発・メンテする必要があり、工数が膨大になる。

## Risks / Trade-offs

- **[Risk] 動的インポートや条件付きインポートの誤認識**
  → *Mitigation*: 静的インポート（`import x`, `from x import y`）を主軸とし、`sys.version_info` や `TYPE_CHECKING` ガード内のインポートは明示的なメタデータ（型専用インポート等）として区別して管理・フィルタ可能にします。
- **[Risk] 大規模リポジトリでのグラフ視認性の悪化**
  → *Mitigation*: Graph-It-Live のように、パッケージ単位でのクラスタリング（折りたたみ/展開）、検索フォーカス、循環参照モジュールのみの抽出ビューを提供します。
- **[Risk] 外部エディタの呼び出し失敗**
  → *Mitigation*: Tauri 設定画面でエディタの優先順位や実行ファイルパスを手動指定・テストできる仕組みを備えます。
