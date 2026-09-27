# モジュール依存図と循環インポート

ModuleLoom の中心機能であるモジュール依存関係の可視化と、循環インポートの自動検出・解消アシスタント、コールグラフ機能の活用方法を解説します。

## 1. 依存関係の可視化と被依存モジュールの確認

<!-- ai:task id=depgraph-overview-text kind=text
モジュール間の依存・被依存関係の読み方、中核モジュール（app.common.database 等）における被依存リストと行番号の確認方法を解説してください。
-->

## 2. 循環インポートの検出と解消アシスタント

Python プロジェクトで実行時エラーや設計破綻の引き金となる「循環インポート」を検出し、安全に解消するための機能です。

<!-- ai:task id=depgraph-cycle-detect-text kind=text
app.user.auth と app.user.session 間の直接循環、および app.user.service から検出される下流循環インポート警告の仕組みと、「循環インポートの解消アシスタント」による解決フローを解説してください。
-->

<!-- ai:task id=depgraph-cycle-guide-screenshot kind=screenshot
#cycle-guide-modal markits rounded-rect, style: danger, callout: '循環インポートの解消アシスタント', pin: '!'
#btn-close-cycle-guide markits circle, style: info, callout: 'アシスタントを閉じる'
-->

<!-- ai:task id=depgraph-cycle-guide-caption-text kind=text
解消アシスタントで提示される修正候補（インターフェース分離や遅延インポート等）の適用時の留意点を説明してください。
-->

## 3. コールグラフによる詳細呼び出し分析

モジュール単位の依存にとどまらず、関数・メソッド単位の呼び出し関係を掘り下げて確認できます。

<!-- ai:task id=depgraph-callgraph-text kind=text
特定のクラスや関数（UserService, authenticate_user 等）の呼び出しフローを視覚化するコールグラフモーダルの機能と操作方法を解説してください。
-->

<!-- ai:task id=depgraph-callgraph-screenshot kind=screenshot
#callgraph-modal markits spotlight, rounded-rect, style: primary, callout: '関数コールグラフ詳細ビュー'
#callgraph-cy-container markits rounded-rect, style: info, callout: 'コールグラフ探索領域'
#btn-close-callgraph markits circle, style: info, callout: 'モーダルを閉じる'
-->

<!-- ai:task id=depgraph-callgraph-caption-text kind=text
コールグラフ表示領域（#callgraph-cy-container）内での探索方法と、複雑な呼び出し経路の特定手法を説明してください。
-->
