# ModuleLoom 検証用サンプルプロジェクト (Sample E-Commerce API)

<!-- ai:generated id=sample-readme-summary kind=text created-at=2026-09-27T21:00:00Z source-sha256=3c9b4b9c15984878ade0ff12bb099c5c3c9b4b9c15984878ade0ff12bb099c5c approved-at=2026-09-27T21:00:00Z -->
このプロジェクトは、**ModuleLoom** の依存関係解析・可視化機能をテスト・体験するために設計されたサンプルPythonプロジェクトです。
<!-- /ai:generated -->

<!-- ai:generated id=sample-readme-features kind=text created-at=2026-09-27T12:31:54Z source-sha256=88afe808e112765bbbe1beefb3f4c5bb51f012e9a422fe99325ba476a15f6276 -->
- モジュール依存グラフの双方向可視化
- 循環インポートの自動検出・経路ハイライト
- コード診断と重複コードの検知
<!-- /ai:generated -->

## ディレクトリ構成とモジュール一覧

```text
sample_project/
├── main.py                     # エントリポイント (app.api, app.config, logger を import)
└── app/
    ├── __init__.py
    ├── config.py               # 設定管理モジュール
    ├── api.py                  # APIルーター (被依存: main / 依存: user.router, order.controller)
    ├── user/
    │   ├── __init__.py
    │   ├── router.py           # ユーザーAPI
    │   ├── service.py          # ユーザービジネスロジック (依存先の auth ⇄ session 循環を検出)
    │   ├── auth.py             # 認証処理 ──┐ 🔄 循環インポート #1
    │   ├── activity.py         # ログイン・セッション集計 (共通関数化候補)
    │   └── session.py          # セッション ┘ (auth ⇄ session)
    ├── order/
    │   ├── __init__.py
    │   ├── controller.py       # 注文API (依存先の processor ⇄ payment 循環を検出)
    │   ├── export.py           # 注文・返金のCSV出力 (コピペ箇所の候補)
    │   ├── processor.py        # 注文処理 ──┐ 🔄 循環インポート #2 & ⚠️ モジュール肥大化 (320行)
    │   └── payment.py          # 決済処理 ──┘ (processor ⇄ payment)
    └── common/
        ├── __init__.py
        ├── database.py         # DB接続 (★被依存モジュールが多数存在する中核モジュール)
        ├── logger.py           # ロガー
        └── utils.py            # ユーティリティ
```

## 各機能のおすすめ検証モジュール

| 検証したい機能 | おすすめ選択モジュール | 確認できること |
| :--- | :--- | :--- |
| **被依存モジュールのリスト** | `app.common.database` | `service.py`, `session.py`, `processor.py`, `payment.py` の4つのモジュールから import されている被依存リストと行番号 (`L:XX`) が並びます。 |
| **依存モジュールのダイアログ図** | `app.api` | 左に被依存 (`main`)、中央に指定 (`app.api`)、右に依存 (`user.router`, `order.controller`, `config`) の3層ダイアログ図が綺麗に表示されます。 |
| **依存モジュールからの循環インポート** | `app.user.service` または `app.order.controller` | 選択モジュール自身は循環していませんが、**「⚠️ 依存先の下流で循環」** 警告カードと `auth ➔ session ➔ auth` などのパスがグラフィカルに表示され、「強調表示」ボタンでアニメーション確認できます。 |
| **直接の循環インポート** | `app.user.auth` または `app.order.processor` | 自身を含む循環インポートパスが赤色バッジと破線エッジで表示されます。 |
| **依存の依存を隠す（直接依存のみ）** | 任意のモジュールを選択し、ヘッダーの **「直接依存のみ」** をON | 深層の推移的依存が消え、選択モジュールの直接の利用元・利用先のみにスッキリ絞り込まれます。 |
| **モジュール肥大化 (Bloat) 検出** | `app.order.processor` | LOC > 300行 のため、オレンジ色の肥大化警告バッジとサイズ拡大が適用されます。 |
| **コピペ箇所の確認** | `app.order.export` | `export_orders` と `export_refunds` に同じCSV出力処理があり、7〜8行の重複として表示されます。 |
| **共通関数化の検討** | `app.user.activity` | `summarize_logins` と `summarize_sessions` に同じ集計処理があり、16〜17行の重複として表示されます。 |

この2組は検出機能を試すため、意図的に重複させています。「診断実行」では jscpd による候補も確認できます。
