# ModuleLoom

![ModuleLoom の依存関係グラフ画面](module_loom.png)

Python モジュールの依存関係、循環インポート、肥大化を可視化するツールです。デスクトップアプリ、PyCharm プラグイン、VS Code 拡張を別々に配布します。

画面の **表示 → 言語** で日本語・英語を切り替えられます。初回は環境の言語を使い、選択内容を保存します。

## GitHub からインストール

[Releases](https://github.com/tamon-ishii/module_loom/releases) から使用する版のファイルを選んでください。

| 用途 | ダウンロードするファイル | インストール |
| --- | --- | --- |
| PyCharm | `ModuleLoom-PyCharm-*.jar` | 設定 → プラグイン → 歯車 → **Install Plugin from Disk** |
| VS Code | `ModuleLoom-VSCode-*.vsix` | 拡張機能画面の `…` → **Install from VSIX** |
| Windows デスクトップ | `ModuleLoom-Desktop-windows-x64-*.exe` | インストーラーを実行 |
| Linux デスクトップ | `ModuleLoom-Desktop-linux-x64-*.AppImage` または `.deb` | AppImage を実行、または deb をインストール |
| macOS デスクトップ | `ModuleLoom-Desktop-macos-*-*.dmg` | CPU に合う `x64` または `arm64` の DMG を開く |

PyCharm と VS Code の配布ファイルには、対応する OS の解析用実行ファイルを同梱しています。解析 CLI を単独で使う場合は `ModuleLoom-CLI-*.zip` を選んでください。現在の対象は Windows と Linux の x64、macOS の x64 と arm64 です。

## リリースの作成

`main` へのプッシュと手動実行では、ビルド結果を GitHub Actions の成果物として保存します。`v` で始まるタグをプッシュすると、3種類の配布ファイルと解析 CLI を GitHub Releases に公開します。

```sh
git tag v1.0.5
git push origin v1.0.5
```

タグの版は `src-tauri/tauri.conf.json` と `plugins/vscode/package.json` の版に合わせてください。

## プロジェクトごとの解析設定

解析対象プロジェクトの直下に `moduleloom.toml` を置くと、肥大化警告の閾値を変更できます。設定ファイルがない場合は、LOC 300、関数 20、クラス 10 が使われます。

```toml
[thresholds]
max_loc = 500
max_functions = 30
max_classes = 15
```

アーキテクチャルールも設定できます。`forbidden` は依存禁止、`independence` は相互依存禁止、`layers` は上位レイヤーから下位レイヤーへの一方向依存を検査します。`protected` は指定モジュールの import 元を許可リストに制限し、`acyclic_siblings` は同じ親の直下にあるパッケージ間の循環を検査します。`ignore_imports` に指定した辺はルール検査から除外し、一致しなくなった例外は違反として報告します。`*` は１階層、`**` は任意の深さに一致します。

```toml
[architecture.forbidden.api_db]
source = "app.api"
target = "app.db"

[architecture.independence.web_domain]
modules = "app.web, app.domain"

[architecture.layers.app]
layers = "app.presentation, app.application, app.domain, app.infrastructure"
closed = ["app.application"]

[architecture.protected.internal]
module = "app.internal"
allowed = ["app.api", "app.tests.*"]

[architecture.acyclic_siblings.features]
parent = "app.features"

[architecture]
ignore_imports = ["app.legacy -> app.internal"]
```

`closed` に挙げた層を飛ばして、その下の層を上位層から直接 import すると違反になります。例外は `source -> target` の形式で、モジュール名にワイルドカードを使えます。

依存宣言と import の食い違いも検査します。DEP001（未宣言）、DEP002（未使用）、DEP003（推移的依存の直接利用）、DEP004（開発用依存の本番利用）、DEP005（標準ライブラリの宣言）を解析結果へ含めます。対象は `requirements.txt` / `requirements.in` とその `-r` 参照、`requirements-dev.txt` / `dev-requirements.txt`、`pyproject.toml` の標準依存・任意依存・dependency groups・Poetry 依存、および `uv.lock` です。任意依存は未使用でも DEP002 にしません。dependency groups は開発用依存として扱います。開発用コードは `tests` / `test` / `testing` ディレクトリと、`test_*.py` / `*_test.py` / `conftest.py` / `noxfile.py` / `toxfile.py` で判定します。import 名と配布パッケージ名が異なる場合や意図的な依存は次の設定で調整できます。

```toml
[dependencies]
ignore = ["pytest"]

[dependencies.import_map]
google = "google-cloud-storage"
```

設定を変更した後は、次回の解析または自動更新時から反映されます。

デスクトップ版は「自動更新」がオンの間、OS のファイル変更通知で対象プロジェクト内の Python ファイルと `moduleloom.toml` を監視します。PyCharm プラグインもツールウィンドウの「自動更新」がオンの間、保存・追加・削除後に再解析します。VS Code 拡張はグラフを開いている間、自動で更新します。連続した変更は短時間まとめて処理し、変更された Python ファイルだけを読み直してから依存関係を再計算します。設定ファイルやフォルダ構成の変更時は全体を再解析します。

CI では `--check` を付けると、解析できなかった Python ファイル、アーキテクチャルール違反、または依存宣言の問題がある場合に終了コード 1 になります。循環と肥大化も失敗条件にする場合は、それぞれ `--check-cycles`、`--check-bloat` を指定します。両方含める場合は `--check-all` を使います。これらのオプションは単独でも `--check` と同じ基本検査を行います。

解析結果にはシンボル、関数呼び出し、循環依存、未使用候補、複雑度、結合度、セキュリティ診断、パッケージ依存も含まれます。モジュール詳細の「コールグラフを表示」から、選択モジュールに関係するシンボル呼び出しを確認できます。ノードのダブルクリックで定義位置を開けます。

画面上部の「総合複雑度」は 0～100 の見直し目安です。循環・相互 import を含むモジュールと結合度（35%）、肥大化モジュールの割合（25%）、関数数あたりの分岐の複雑さ（20%）、重複行の割合（20%）から計算します。値が高いほど確認を勧めます。各内訳と優先候補を表示し、候補を押すと依存図へ移動できます。重複は空行とコメント行を除いた連続 6 行が一致する箇所を候補として表示し、行番号からエディタで確認できます。文字列や変数名を変えた類似コードは検出対象外です。解析できなかったファイルは集計に含まれないため、解析エラーも確認してください。

「コード診断」欄の「診断実行」は詳細解析を明示的に実行します。ファイル変更時の自動更新は通常のモジュール解析で、詳細診断はボタンから再実行します。実行中表示の後、総合複雑度の内訳、優先候補、重複箇所、マジックナンバー、重複リテラルを表示し、検出箇所からエディタへ移動できます。分岐の複雑さは [Lizard](https://github.com/terryyin/lizard)、重複コードは [jscpd](https://jscpd.dev/)、比較式に含まれるマジックナンバーは [Ruff の PLR2004](https://docs.astral.sh/ruff/rules/magic-value-comparison/) を使用します。重複リテラルは ModuleLoom が Python の構文木から、8文字以上の文字列または `0`・`1` 以外の数値が3回以上出現する候補を検出します。マジックナンバーはすべての数値リテラルを対象にするものではありません。Lizard または jscpd が利用できない場合は ModuleLoom の推定値に戻し、画面とJSONに採用した解析器を記録します。外部ツールは解析対象プロジェクトの `.venv` / `venv`、`node_modules/.bin`、または `PATH` から検索します。

```bash
uv sync --group dev
moduleloom-analyze --quality-report ./my-project > quality-report.json
moduleloom-analyze --quality-report --max-score 40 ./my-project
```

`--quality-report` はAIやCI向けの要約JSONを標準出力に出します。総合複雑度と内訳、解析器、優先モジュールと行番号、重複箇所、リテラル検出、循環・設計違反・依存宣言の問題・解析エラーを含みます。全モジュールの解析結果が必要なら `--quality --json` を使用します。`--max-score N` は詳細診断を実行して総合複雑度が N を超えたとき終了コード1にします。スコアは見直しの目安なので、閾値はプロジェクトに合わせて設定してください。

循環インポートでは実在する代表経路と import 行を表示します。改善候補は、型注釈のみの直接参照、実行時の参照、判定できない参照を区別します。候補は確認の起点であり、複数の経路を持つ循環では1か所の変更だけで解消しない場合があります。

デスクトップ版では「修正ツール」で外部ツールを選べます。標準の Ruff は、型注釈専用と判定した改善候補に対して TC001 の差分を提示します。差分を確認してから適用し、循環を再解析します。Ruff はプロジェクトの `.venv` / `venv` または `PATH` にインストールしてください。TC001 は import の実行時期を変える可能性があり、Ruff では unsafe fix に分類されています。

ほかの修正ツールは `moduleloom.toml` へ登録できます。次の例の `tools/fix-cycle` はユーザーが用意する実行ファイルです。

```toml
[fix_tools.my_fixer]
label = "My fixer"
command = "tools/fix-cycle"
preview_args = ["--diff", "{file}", "{source}", "{target}", "{line}"]
apply_args = ["--write", "{file}", "{source}", "{target}", "{line}"]
kinds = ["type_only", "runtime", "unknown"]
```

プレビュー用コマンドはファイルを変更せず、差分を標準出力へ出してください。適用用コマンドは修正を書き込みます。引数はシェルを経由せずに渡され、作業ディレクトリはプロジェクトのルートです。`{project}` も引数に使えます。適用前には対象ファイルとプレビュー差分が変わっていないことを確認します。独自ツールが対象ファイル以外も編集する場合は、表示された差分の範囲を確認してください。

「解析データを JSON で保存」では、現在の解析結果全体を保存できます。VS Code / PyCharm 版は解析対象の `.moduleloom`、デスクトップ版はダウンロード先に保存します。解析結果はプロジェクトごとに最大 20 件までブラウザ内へ保存され、任意の 2 件を選ぶ履歴比較とシンボル・依存関係の削除候補比較に使われます。保存容量が足りない場合は古い履歴から減らします。

「変更ファイルを強調」では、作業中の変更か指定した 2 つのコミット間の変更を選び、該当する Python ファイルを依存図上で強調します。修正したモジュールがどこにあり、周囲にどんな依存関係があるかを確認するときに使います。コードの行単位の差分や、変更による影響範囲を自動判定する機能ではありません。「問題一覧」には依存宣言の問題も含まれます。import 経路検索では、解析済みモジュールを出発点と到着点に選びます。

## MkDocs マニュアル生成

デスクトップ版または PyCharm プラグインの「MkDocs 出力」、あるいは CLI の `--mkdocs` で、全体依存図、モジュール別ページ、API 一覧ページを含む MkDocs プロジェクトを生成できます。各モジュールページにはモジュール・クラス・関数・メソッドの docstring と、クラスの基底クラス、呼び出し可能オブジェクトの引数・既定値・型注釈・戻り値注釈を掲載します。Google、NumPy、Sphinx 形式の docstring 見出しも Markdown に整えます。ソースコード本文は出力しません。PyCharm とデスクトップ版は生成先・モジュール数・言語を確認してから生成します。

表示言語は `auto`（マシンのロケールから自動選択）、`ja`、`en`、`fr`、`de`、`es`、`zh`、`ko`、`pt` を指定できます。PyCharm では出力時に選択し、CLI では `--lang` で指定します。

```sh
moduleloom-analyze --mkdocs ./moduleloom-docs ./my-project
# 日本語で生成する場合
moduleloom-analyze --mkdocs ./moduleloom-docs --lang ja ./my-project
cd moduleloom-docs
mkdocs serve
```

生成した `mkdocs.yml` は Material for MkDocs と Mermaid 用に設定されています。表示には `mkdocs-material` が必要です。Mermaid の JavaScript とライセンス表示は生成先に同梱するため、図はオフラインでも表示できます。翻訳カタログは解析器の `mkdocs_i18n.json` で管理します。出力先は空のディレクトリ、または以前 ModuleLoom が生成したディレクトリを指定してください。再生成時は生成ページが更新され、不要になった生成ページは削除されます。

全体図では「外部ノード」でプロジェクト外への import を表示でき、モジュール選択後に「表示範囲」で 1～3 ホップへ絞れます。「集約」は指定件数を超える同一パッケージ内のモジュールを１ノードにまとめ、ダブルクリックで展開できます。「経路検索」は２モジュール間の最短 import 経路を強調表示します。CLI でも `moduleloom-analyze --chain app.api app.db ./my-project` で照会できます（`--json` も併用可能）。

```sh
moduleloom-analyze --check ./my-project
```
