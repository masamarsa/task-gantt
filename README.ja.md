# Task Gantt

[English](README.md)

個人用のタスク進捗管理アプリです。Pythonの標準ライブラリとSQLiteを使い、ブラウザでタスク、ガントチャート、日・週・月の統計を確認できます。

## 起動

Python 3.10以上が必要です。Gitコミットの取り込みを使う場合はGitも用意してください。

```sh
python3 app.py
```

ブラウザで [http://127.0.0.1:8080](http://127.0.0.1:8080) を開きます。既定のデータベースは `data/tracker.sqlite3` です。`TASK_GANTT_DB` で別のパス、`--port` で別のポートを指定できます。初回起動時にデータベースが作成されます。

アプリは個人利用を想定しており、既定ではループバックにのみ接続を受け付けます。リモート端末から使う場合も、SSHのローカルポート転送経由で接続できます。外部公開する場合はアプリの前段で認証とHTTPSを設定してください。

### systemd ユーザーサービスで起動

systemd を使用する Linux で、アプリを実行するユーザーとしてリポジトリのルートから実行します。

```sh
mkdir -p "$HOME/.local/share"
ln -sT "$(pwd -P)" "$HOME/.local/share/task-gantt"
install -Dm 0644 systemd/task-gantt.service "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/task-gantt.service"
systemctl --user daemon-reload
systemctl --user enable --now task-gantt.service
```

すでに `~/.local/share/task-gantt` からリポジトリにアクセスできる場合は、`ln` を省略します。サービスはログイン時に起動します。ユーザーの lingering が無効であれば、最後のログアウト後にユーザーマネージャーとともに停止します。

サービスは `TASK_GANTT_HOST` に `127.0.0.1`、`TASK_GANTT_PORT` に `8080`、`TASK_GANTT_DB` に `~/.local/share/task-gantt/data/tracker.sqlite3` を設定します。変更する場合は `~/.config/task-gantt/environment` に `名前=値` の形式で記載し、`systemctl --user restart task-gantt.service` を実行します。DB の変更には絶対パスを指定してください。状態は `systemctl --user status task-gantt.service` で確認できます。

リポジトリを更新した後は `systemctl --user restart task-gantt.service` を実行します。実行中のプロセスは HTML をファイルから読み込みますが、Python の配信ルートは起動時のものを使います。再起動するまでは `markdown-editor.js` や `markdown-editor.css` など、新しく追加されたファイルが `404` になる場合があります。

## タスクとステータス

タスクの「題名」「対応内容」「対応方針」と、目標・予定・実績の開始／終了日時、予定工数・AI予想工数・実績工数を入力できます。日時は日本時間、工数は時間単位です。AI予想工数欄には、Copilotなどで得た見積もりを入力します。

- タスク詳細は表示モードで開きます。**編集**で変更できるようになり、**保存**で変更を保存して表示モードに戻ります。
- 対応内容と対応方針は、各欄を押すと Markdown の入力画面とプレビューを使えます。見出し、強調、リスト、引用、コード、リンク、`|` 区切りの表に対応しています。
- 実績開始日時が保存されているタスクでは、**計測工数を入力**で現在の計測値を実績工数欄に入力できます。入力した値は**保存**で確定します。
- **開始**を押すと実績開始日時が、**終了**を押すと実績終了日時が記録されます。
- **保留**から**再開**までの時間は自動計測から除外します。保留中のまま終了することもできます。
- 過去の作業は実績日時を手入力できます。実績開始のみなら開始、実績終了まで入力すると終了になります。
- 実績工数を入力すると手入力値が優先されます。自動計算では、日本時間の月〜金の 09:00〜12:00 と 13:00〜18:00 を対象に、祝日（振替休日・国民の休日を含む）と保留中の時間を除きます。
- タスク詳細では目標・予定の各日時、予定工数・AI予想工数に対する実績との差分を表示します。差分は実績から基準を引いた値です。
- 「GitHub Copilot Agent」から、編集フォームの内容と Task Gantt API の呼び出し方を含むチケット記入用・更新用プロンプトをコピーできます。エージェントは保存済みのタスクを取得し、フォームで編集中の項目を反映した記入案を返します。Task Gantt への保存は、エージェントに依頼した場合に行います。

1955〜2027年の祝日は内閣府の公表日を使います。2028年以降は現行法に基づいて計算し、春分・秋分は2050年までの推計日を使います。[内閣府](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html) · [国立天文台](https://www.nao.ac.jp/faq/a0301.html)

## AI エージェント向け API

アプリを起動し、AI エージェントの実行環境からブラウザで開いたアプリの URL に接続できる状態にします。プロンプトにはその URL が入ります。接続できない環境でも、プロンプト内のフォーム情報で記入案を作成できます。

| 操作 | メソッドとパス | 入出力 |
| --- | --- | --- |
| タスク作成 | `POST /api/tasks` | `title` は必須。ほかの編集項目は任意。`201` と `id` を返します。 |
| タスク取得 | `GET /api/tasks/{id}` | `200` とタスクを返します。更新に使う `revision`、ステータス、計測工数、Git 参考情報を含みます。 |
| タスク部分更新 | `PATCH /api/tasks/{id}` | 取得した `revision` と変更する編集項目を指定します。省略した項目は保持されます。`200` と `id`、新しい `revision` を返します。 |
| ステータス変更 | `POST /api/tasks/{id}/status` | 取得した `revision` と `status`（`started`、`held`、`resumed`、`finished`）を指定します。許可された状態遷移で `200` と `id` を返します。 |

書き込みには `Content-Type: application/json` を指定します。編集項目は次のとおりです。

- テキストは `title`（題名）、`description`（対応内容）、`approach`（対応方針）。対応内容・対応方針を消すには `""` を指定します。
- 日時は `goal_start` / `goal_end`（目標）、`plan_start` / `plan_end`（予定）、`actual_start` / `actual_end`（実績）。日本時間の `YYYY-MM-DDTHH:MM[:SS]` または末尾に `+09:00` を付けた形式を使います。未設定には `null` を指定します。
- 工数は `plan_hours`（予定）、`ai_hours`（AI予想）、`actual_hours`（実績）。時間単位で小数第2位まで指定できます。未設定には `null` を指定します。

たとえば、次のコマンドでタスクの作成、現在の値の取得、AI予想工数だけの更新ができます。取得と更新の例では、作成時に返った `id` と取得時の `revision` を使ってください。

```sh
task_gantt_api=http://127.0.0.1:8080/api/tasks
curl --fail-with-body -sS -H 'Content-Type: application/json' \
  -d '{"title":"CSV出力を追加","description":"明細をCSVで取得できるようにする"}' "$task_gantt_api"
curl --fail-with-body -sS "$task_gantt_api/1"
curl --fail-with-body -sS -X PATCH -H 'Content-Type: application/json' \
  -d '{"revision":1,"ai_hours":3.5}' "$task_gantt_api/1"
```

エラー時は `error` を含む JSON を返します。入力エラーは `400`、対象が存在しない場合は `404`、更新時に `revision` が競合した場合は `409` です。`409` の場合は最新のタスクを取得し、変更内容を見直してから更新します。

## 期間統計

日・週・月は日本時間で区切り、週は月曜始まりです。期間内の開始・終了件数と実績工数を表示します。

- 開始日時と終了日時は、それぞれの実績が選択期間に入るタスクを集計します。
- 工数の比較は、期間内に終了したタスクのうち比較元の工数が入力されたタスクを対象とします。
- 期間内の実績工数は、日付をまたぐ作業を各期間に配分します。手入力の実績工数は、期間ごとの自動計測時間の比率で配分します。計測時間がない場合は実績終了日時、終了日時がなければ実績開始日時の期間に計上します。

## Gitコミットの参考日時

アプリとは別のCLIを、同じSQLiteファイルにアクセスできる環境で実行します。タスクIDは詳細画面に表示されます。

```sh
python3 git_reference.py --task 1 --repo /path/to/repository --ticket PROJ-123
```

ローカルのGit参照からたどれる履歴を検索し、メッセージ内でチケットキーが一致したコミットの最初・最後のコミッター日時と件数を保存します。タイムラインとタスク詳細にGit参考日時として表示されます。実績日時と工数はそのまま保持されます。同じタスクへの再実行で参考情報が更新されます。カスタムDBパスを使っている場合はCLIにも同じ `TASK_GANTT_DB` を指定してください。
