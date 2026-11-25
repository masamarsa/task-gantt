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

## Tasks and statuses

Each task has a title, a description, and an approach. You can enter target, planned, and actual start and end times, as well as planned, AI-estimated, and actual effort. Times use Japan Standard Time (JST), and effort is measured in hours. Enter estimates from tools such as Copilot in the AI estimate field.

- **Start (開始)** records the actual start time. **Finish (終了)** records the actual end time.
- The timer excludes time between **Hold (保留)** and **Resume (再開)**. You can also finish a task while it is on hold.
- To record past work, enter the actual times manually. Entering a start time marks a new task as started. Entering both times marks it as finished.
- A manually entered actual effort value takes precedence. If the field is blank, the app uses tracked work time excluding holds.
- Task details compare actual values with target and planned times, planned effort, and AI-estimated effort. Each difference is the actual value minus its baseline.
- In the **GitHub Copilot Agent** section, you can copy prompts for drafting or updating a ticket. The prompts include the current form values and instructions for calling the Task Gantt API. The agent can fetch the saved task and incorporate unsaved form edits into its draft. It writes changes back to Task Gantt when you ask it to.

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
