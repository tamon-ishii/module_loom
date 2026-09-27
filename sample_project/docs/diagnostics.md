# コード品質診断と自動修復

「コード診断」画面（`#complexity-dashboard`）では、プロジェクト全体の複雑度、モジュールの肥大化、重複コード、静的解析エラーを一元的に測定し、自動修復やコーディングエージェント連携を行うことができます。

## 1. コード診断の実行と問題の絞り込み

<!-- ai:task id=diagnostics-overview-text kind=text
コード診断ダッシュボードで診断を実行し、問題一覧（issues）を検索・フィルタリングして重大な品質リスクを特定する手順を解説してください。
-->

<!-- ai:task id=diagnostics-dashboard-screenshot kind=screenshot
#complexity-dashboard markits spotlight, rounded-rect, style: primary
#btn-quality markits badge: 1, rounded-rect, style: primary, callout: '診断実行ボタンで最新コードをスキャン'
#issues-search-filter markits badge: 2, rounded-rect, style: info, callout: '問題のキーワード絞り込み'
-->

<!-- ai:task id=diagnostics-dashboard-caption-text kind=text
診断実行によって検出される項目（app.order のモジュール肥大化、app.user.activity のコード重複など）の見方を補足してください。
-->

## 2. Ruff によるコードスタイルの自動修正

静的解析ツール Ruff による指摘事項を、GUI 上からワンクリックでソースコードへ安全に適用できます。

<!-- ai:task id=diagnostics-ruff-fix-text kind=text
Ruff 自動修正モーダル（#ruff-fix-modal）での差分プレビュー確認手順と、ソースコードへの一括適用フローを解説してください。
-->

<!-- ai:task id=diagnostics-ruff-modal-screenshot kind=screenshot
#ruff-fix-modal markits spotlight, rounded-rect, style: warning
#btn-apply-ruff-fix markits callout: '差分をソースコードに適用', rounded-rect, style: primary
#btn-close-ruff-fix markits circle, style: info, callout: '修正モーダルを閉じる'
-->

<!-- ai:task id=diagnostics-ruff-caption-text kind=text
差分適用後の自動再診断と、Git コミット前の差分検証に関する注意点を説明してください。
-->

## 3. コーディングエージェント連携スキルのインストール

Codex、Claude Code、Cursor などのコーディングエージェントに対し、ModuleLoom の診断 CLI を活用した自律修復スキル（`moduleloom-diagnostics`）を自動インストールできます。

<!-- ai:task id=diagnostics-skill-install-text kind=text
「コード診断スキルをインストール」ボタンの動作仕様、検出対象エージェントの判定ロジック、およびエージェントが自律的にコードを修正・検証する仕組みを解説してください。
-->

<!-- ai:task id=diagnostics-skill-button-screenshot kind=screenshot
#btn-install-skill markits callout: '検出したエージェントに診断スキルを自動導入', pin: 'AI', rounded-rect, style: pink
-->

<!-- ai:task id=diagnostics-skill-caption-text kind=text
インストール完了後に各エージェントから診断スキルを呼び出してコード修復を行うプロンプト例を紹介してください。
-->
