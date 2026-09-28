# ModuleLoom ユーザーマニュアル

ModuleLoom は Python モジュールの依存関係を図で表示し、循環インポートやコード上の問題を調べるツールです。ここでは `sample_project`（19 モジュール）を例に、解析からマニュアル出力までの操作を説明します。画面はデスクトップ版を基にしています。

<!-- ai:task id=index-overview kind=screenshot
ModuleLoom のモジュール一覧と依存図が見える画面を撮影する。
-->

<!-- ai:generated id=index-overview kind=screenshot prompt-b64=TW9kdWxlTG9vbSDjga7jg6Ljgrjjg6Xjg7zjg6vkuIDopqfjgajkvp3lrZjlm7PjgYzopovjgYjjgovnlLvpnaLjgpLmkq7lvbHjgZnjgovjgII= source-sha256=80f14bbd4d860c77ad53643b027227f90712a63cbbe0ced488f2061732ca5dbc -->
![sample_project を解析したモジュール一覧と依存図](assets/getting-started.png)
<!-- /ai:generated -->

## 操作ガイド

1. [解析を始める](quickstart.md) — プロジェクトの指定、依存図とモジュール詳細の見方
2. [循環インポートとコード診断](analysis.md) — 循環経路の確認、診断結果の絞り込み
3. [ドキュメントを生成する](manual.md) — 原稿と画像の更新、MkDocs サイトの作成

解析対象に別の Python プロジェクトを指定しても、基本操作は同じです。診断件数や総合複雑度は対象コードと解析環境によって変わります。
