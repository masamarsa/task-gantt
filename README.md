# Task Gantt

[日本語で読む](README.ja.md)

Task Gantt is a personal task tracker built with the Python standard library and SQLite. Use your browser to manage tasks, view a Gantt chart, and review daily, weekly, and monthly statistics.

## Getting started

Use Python 3.10 or later. Install Git if you want to import commit timestamps.

```sh
python3 app.py
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080) in your browser. The app creates its database on first launch at `data/tracker.sqlite3`. Set `TASK_GANTT_DB` to use a different database path, or pass `--port` to use another port.

The app is designed for personal use and listens on the loopback interface by default. You can access it remotely through SSH local port forwarding. If you expose it publicly, configure authentication and HTTPS in front of the app.

### Run as a systemd user service

On a Linux host with systemd, run the following from the checkout root as the user who will run Task Gantt.

```sh
mkdir -p "$HOME/.local/share"
ln -sT "$(pwd -P)" "$HOME/.local/share/task-gantt"
install -Dm 0644 systemd/task-gantt.service "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/task-gantt.service"
systemctl --user daemon-reload
systemctl --user enable --now task-gantt.service
```

Skip the `ln` command if the checkout is already available at `~/.local/share/task-gantt`. The user service starts at login. With systemd lingering disabled for the account, it stops when the user manager shuts down after the last logout.

The unit sets `TASK_GANTT_HOST` to `127.0.0.1`, `TASK_GANTT_PORT` to `8080`, and `TASK_GANTT_DB` to `~/.local/share/task-gantt/data/tracker.sqlite3`. To override settings, add `NAME=value` entries to `~/.config/task-gantt/environment` and run `systemctl --user restart task-gantt.service`. Use an absolute path when overriding `TASK_GANTT_DB`. Check status with `systemctl --user status task-gantt.service`.

After updating the checkout, run `systemctl --user restart task-gantt.service`. The running process reads HTML from disk and keeps the Python routes loaded at startup, so new assets such as `markdown-editor.js` and `markdown-editor.css` can return `404` until you restart the service.

## Tasks and statuses

Each task has a title, a description, and an approach. You can enter target, planned, and actual start and end times, as well as planned, AI-estimated, and actual effort. Times use Japan Standard Time (JST), and effort is measured in hours. Enter estimates from tools such as Copilot in the AI estimate field.

- Task details open in view mode. Select **Edit (編集)** to make changes and **Save (保存)** to save them and return to the detail view.
- Select the description or approach field to open its Markdown editor and preview the result. The app supports headings, emphasis, lists, quotes, code, links, and pipe tables.
- For a task with a saved actual start time, **Insert tracked effort (計測工数を入力)** copies the current tracked value into the actual effort field. Select **Save (保存)** to keep it.
- **Start (開始)** records the actual start time. **Finish (終了)** records the actual end time.
- The timer excludes time between **Hold (保留)** and **Resume (再開)**. You can also finish a task while it is on hold.
- To record past work, enter the actual times manually. Entering a start time marks a new task as started. Entering both times marks it as finished.
- A manually entered actual effort value takes precedence. Automatic tracking counts Monday to Friday from 09:00–12:00 and 13:00–18:00 JST, excluding Japanese public holidays (including substitute and citizens’ holidays) and time spent on hold.
- Task details compare actual values with target and planned times, planned effort, and AI-estimated effort. Each difference is the actual value minus its baseline.
- In the **GitHub Copilot Agent** section, you can copy prompts for drafting or updating a ticket. The prompts include the current form values and instructions for calling the Task Gantt API. The agent can fetch the saved task and incorporate unsaved form edits into its draft. It writes changes back to Task Gantt when you ask it to.

The holiday calendar uses Cabinet Office dates for 1955–2027. Later years follow current law, with equinox estimates through 2050. [Cabinet Office](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html) · [National Astronomical Observatory of Japan](https://www.nao.ac.jp/faq/a0301.html)

## API for AI agents

Start the app and make sure the agent can reach the same URL you use in your browser. The copied prompt includes that URL. If the agent cannot reach the app, it can still draft a ticket using the form values in the prompt.

| Operation | Method and path | Request and response |
| --- | --- | --- |
| Create a task | `POST /api/tasks` | Supply `title` and any optional editable fields. Returns `201` and the task `id`. |
| Get a task | `GET /api/tasks/{id}` | Returns `200` and the task, including the `revision` required for updates, status, tracked effort, and Git reference data. |
| Update selected fields | `PATCH /api/tasks/{id}` | Supply the current `revision` and the fields you want to update. Omitted fields keep their values. Returns `200`, the task `id`, and the new `revision`. |
| Change status | `POST /api/tasks/{id}/status` | Supply the current `revision` and the requested `status` (`started`, `held`, `resumed`, or `finished`). An allowed transition returns `200` and the task `id`. |

For write requests, use `Content-Type: application/json`. The following fields are editable.

- Text fields are `title`, `description`, and `approach`. Send `""` to clear the description or approach.
- Date and time fields are `goal_start` and `goal_end` (target), `plan_start` and `plan_end` (planned), and `actual_start` and `actual_end` (actual). Supply JST values as `YYYY-MM-DDTHH:MM[:SS]`, optionally followed by `+09:00`. Send `null` to clear a value.
- Effort fields are `plan_hours`, `ai_hours`, and `actual_hours`. Supply hours with up to two decimal places, or send `null` to clear a value.

The following commands create a task, fetch it, and update its AI estimate. Replace the example ID and revision with the values returned by the create and get requests.

```sh
task_gantt_api=http://127.0.0.1:8080/api/tasks
curl --fail-with-body -sS -H 'Content-Type: application/json' \
  -d '{"title":"Add CSV export","description":"Make itemized records available as CSV"}' "$task_gantt_api"
curl --fail-with-body -sS "$task_gantt_api/1"
curl --fail-with-body -sS -X PATCH -H 'Content-Type: application/json' \
  -d '{"revision":1,"ai_hours":3.5}' "$task_gantt_api/1"
```

Error responses are JSON objects with an `error` field. Invalid input returns `400`, a missing task returns `404`, and a revision conflict returns `409`. After a `409`, fetch the latest task and review your changes before retrying.

## Period statistics

Days, weeks, and months use JST boundaries. Weeks start on Monday. For the selected period, the app shows how many tasks started and finished, along with actual effort.

- A task counts as started or finished based on whether its corresponding actual timestamp falls within the selected period.
- Effort comparisons include tasks that finished in the selected period and have an estimate for the baseline being compared.
- The app allocates actual effort across periods when work spans multiple dates. Manual effort is distributed in proportion to the tracked work time in each period. With no tracked work time, the app assigns manual effort to the period containing the actual end time, or the actual start time if the end is unset.

## Git commit reference times

Run the import CLI where it can access the same SQLite database as the app. The task ID appears in the task details.

```sh
python3 git_reference.py --task 1 --repo /path/to/repository --ticket PROJ-123
```

The CLI searches commits reachable from local Git refs for the ticket key in their messages. It saves the earliest and latest matching committer timestamps and the number of matches. The timeline and task details display the imported values as Git reference times. The import preserves actual work times and effort. Running it again for the same task refreshes the reference data. If you use a custom database path, set the same `TASK_GANTT_DB` value for the CLI and the app.
