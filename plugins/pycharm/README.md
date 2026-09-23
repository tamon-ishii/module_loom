# ModuleLoom for PyCharm

ModuleLoom は、PyCharm 内で Python プロジェクトのモジュール依存関係を図にして確認するプラグインです。循環インポートや規模の大きいモジュールを見つけ、図からソースコードへ移動できます。

## JetBrains Marketplace への公開

初回掲載は[Marketplace](https://plugins.jetbrains.com/)で行います。JetBrainsアカウントでVendor profileを作成し、Marketplace Developer Agreementに同意した後、プラグインJARを登録してください。説明、カテゴリ、タグ、対応製品、ライセンスとライセンスURL、ソースコードURLを掲載フォームで設定します。公開前にJetBrainsの審査があります。

初回掲載後は、GitHubの `main` ブランチへのプラグイン関連ファイルのpushでGitHub ActionsがJARをビルドし、Marketplaceへ更新をアップロードします。リポジトリの **Settings → Secrets and variables → Actions** にMarketplaceのPermanent Tokenを `JETBRAINS_MARKETPLACE_TOKEN` という名前で登録してください。トークンはMarketplaceプロフィールの **My Tokens** で発行します。GitHub Actionsの実行番号から更新ごとに異なるバージョンを設定します。

Marketplaceへのアップロードには既存の掲載が必要です。初回登録前にActionsが動いた場合はアップロード工程が失敗するため、掲載完了後に `main` へ再度pushするか、Actionsから **Publish PyCharm plugin → Run workflow** を実行してください。

## インストール

1. [GitHub Releases](https://github.com/tamon-ishii/module_loom/releases) から `ModuleLoom-PyCharm-*.jar` をダウンロードします。
2. PyCharm の **Settings (Preferences) → Plugins** を開き、歯車メニューから **Install Plugin from Disk...** を選びます。
3. ダウンロードした JAR を選択し、PyCharm を再起動します。
4. 右側のツールウィンドウバーから **ModuleLoom** を開きます。

プラグインには解析エンジンが同梱されます。対応する配布ビルドは Windows x64、Linux x64、macOS x64 / arm64 向けです。ツールウィンドウの表示には PyCharm の JCEF (Chromium Embedded Framework) が必要です。

## 使い方

ツールウィンドウ上部の **解析対象** で解析するプロジェクトを選び、**再解析** を押します。通常は開いているプロジェクト全体を解析します。プロジェクト直下に `sample_project` がある場合は、それを個別に選べます。

同じ解析対象を MkDocs マニュアルにするには、**MkDocs 出力** を押して出力先と言語を選択します。`auto` はマシンのロケールを使います。生成物には API 一覧とモジュール別ページが含まれ、Mermaid のスクリプトを同梱するためオフラインでも図を表示できます。生成後はそのフォルダで `mkdocs serve` を実行します。表示には `mkdocs-material` が必要です。

ツールウィンドウのグラフでは、モジュールを選択して詳細を確認できます。循環インポートは図上で強調され、一覧や詳細から関連する import 行とファイルへ移動できます。ファイルを開く操作は PyCharm のエディタを使います。

デスクトップ版と共通の解析画面から、Git変更・コミット比較、解析データの JSON 保存、MkDocs生成、Ruffによる循環インポート修正の差分確認と適用も利用できます。Ruffはプロジェクトの `.venv` / `venv` または `PATH` にインストールしてください。修正後は自動で再解析します。

| 操作 | 結果 |
| --- | --- |
| **全体図** | 解析対象に含まれる全モジュールの図を表示 |
| **ツリー** | ソースツリーの表示・非表示を切替 |
| **Fit** | 図全体が見える倍率に調整 |
| **循環のみ** | 循環に関係するモジュールに絞り込み |
| モジュールをダブルクリック | そのモジュールの依存図を表示 |
| ファイルや import の位置を選択 | 該当ファイルを PyCharm で開き、指定行へ移動 |

グラフ上のズーム操作やレイアウト切替も利用できます。モジュール図から全体図へ戻るには **全体図** を押します。

### PyCharm から図を開く

プロジェクトビューまたはエディタ上で Python ファイルを右クリックし、**ModuleLoom で依存図を開く** を選ぶと、そのファイルの依存図を表示します。ディレクトリを右クリックした場合はそのディレクトリを解析します。

**ダブルクリック連動** がオンの場合、PyCharm 側で Python ファイルをダブルクリックして開くと、ModuleLoom もそのファイルの依存図へ移動します。ModuleLoom からエディタを開いた場合、この連動は起動しません。

### 自動更新

**自動更新** がオンの間、解析対象内の Python ファイルや `moduleloom.toml` の保存、追加、削除後に再解析します。連続した変更はまとめて処理されます。変更ファイルだけを使う増分解析が失敗した場合は全体を再解析します。設定を変えた直後に結果を更新したい場合は **再解析** を押してください。

## 解析設定

解析対象プロジェクトのルートに `moduleloom.toml` を置くと、肥大化の閾値やアーキテクチャルールを設定できます。書式の例は[プロジェクト全体の README](../../README.md#プロジェクトごとの解析設定)を参照してください。設定がない場合の既定値は LOC 300、関数 20、クラス 10 です。

## トラブルシューティング

- **ModuleLoom がツールウィンドウにない:** プラグインが有効か確認し、PyCharm を再起動してください。
- **JCEF 非対応のメッセージが出る:** 使用中の IDE 環境で JCEF が利用可能か確認してください。
- **解析に失敗する:** 対応 OS / CPU の PyCharm を使っているか確認し、ツールウィンドウで **再解析** を実行してください。
- **グラフからエディタへ移動できない:** ファイルが現在のプロジェクト内にあり、PyCharm からアクセス可能か確認してください。

## 開発者向けビルド

ビルドには Node.js / npm、`npm ci` 済みのリポジトリ、JDK 21 と、`jbr/bin/javac` および `lib/*.jar` を含む展開済み PyCharm が必要です。`PYCHARM_HOME` で PyCharm の場所を指定して JAR をビルドします。

```sh
PYCHARM_HOME=/path/to/pycharm python3 scripts/build_pycharm_plugin.py --build-only
```

生成物は `target/pycharm-plugin/moduleloom.jar` です。開発環境へビルドと同時にインストールする場合は `--build-only` を省略します。ビルド済み JAR だけをインストールするには `--install-only` を指定します。
