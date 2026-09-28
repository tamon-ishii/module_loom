# 解析を始める

## プロジェクトを指定する

デスクトップ版では上部のパス欄に Python プロジェクトのルートを入力し、**解析実行**を押します。PyCharm 版と VS Code 版では、開いているプロジェクトを対象に解析します。

解析が終わると、左に `.py` ファイルのツリー、中央に import の依存図、右に選択したモジュールの詳細が表示されます。

<!-- ai:task id=quickstart-overview kind=screenshot
左のソースツリー、中央の依存図、右のモジュール詳細が見える解析画面を撮影する。
-->

<!-- ai:generated id=quickstart-overview kind=screenshot prompt-b64=5bem44Gu44K944O844K544OE44Oq44O844CB5Lit5aSu44Gu5L6d5a2Y5Zuz44CB5Y+z44Gu44Oi44K444Ol44O844Or6Kmz57Sw44GM6KaL44GI44KL6Kej5p6Q55S76Z2i44KS5pKu5b2x44GZ44KL44CC source-sha256=9c6f05c1e3d93af43ae568f435c96c9dbe1d943675f17171cea2452f334b908d -->
![左からソースツリー、依存図、モジュール詳細が並ぶ解析画面](assets/getting-started.png)
<!-- /ai:generated -->

## 依存図を読む

ノードはモジュール、矢印は import の向きを表します。左のツリーで `app/order/payment.py` を選ぶと、右側に行数、関数、import 先と import 元が表示されます。import の行番号から該当コードを確認できます。

<!-- ai:task id=quickstart-overview-button kind=screenshot
モジュール一覧の全体図を見るボタンの位置が分かる画面を撮影する。
-->

<!-- ai:generated id=quickstart-overview-button kind=screenshot prompt-b64=44Oi44K444Ol44O844Or5LiA6Kan44Gu5YWo5L2T5Zuz44KS6KaL44KL44Oc44K/44Oz44Gu5L2N572u44GM5YiG44GL44KL55S76Z2i44KS5pKu5b2x44GZ44KL44CC source-sha256=981dffd5954875028eefe3fdda25d0045ef9dec28bf9530d956001ff90c541e3 -->
![全体図ボタンの位置](assets/overview-button.png)
<!-- /ai:generated -->

**全体図を見る**を押すと、プロジェクト内のモジュールをまとめて表示します。全体図でノードを選ぶと詳細が表示され、ダブルクリックするとそのモジュールを中心とした依存図に切り替わります。

<!-- ai:task id=quickstart-full-graph kind=screenshot
sample_project の全体依存図が表示された画面を撮影する。
-->

<!-- ai:generated id=quickstart-full-graph kind=screenshot prompt-b64=c2FtcGxlX3Byb2plY3Qg44Gu5YWo5L2T5L6d5a2Y5Zuz44GM6KGo56S644GV44KM44Gf55S76Z2i44KS5pKu5b2x44GZ44KL44CC source-sha256=2cb7299fbbebf7083f9061124e18b364e4179e372dff2c1643887a7a4b7c493a -->
![sample_project の全体依存図](assets/full-graph.png)
<!-- /ai:generated -->

大きいプロジェクトでは、上部の検索欄や **表示** メニューの表示範囲・集約を使って図を絞り込めます。2 モジュール間の import 経路は **分析** メニューの「import 経路検索」で調べられます。
