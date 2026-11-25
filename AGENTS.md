# Repository Guidelines

## Project Structure

- `app.py` serves the WSGI JSON API and the browser assets.
- `tracker.py` owns the SQLite schema, task validation, status transitions, and period statistics.
- `git_reference.py` imports commit timestamps for a ticket from a local Git repository into an existing task.
- `static/` contains the Japanese-language UI in `index.html`, `style.css`, and `app.js`. `data/` holds the default local database and is ignored by Git.

## Build, Test, and Development Commands

Run commands from the repository root with Python 3.10 or newer. The app uses the Python standard library and serves static files directly, so setup requires no package installation or build step. Git is required for the import CLI.

- `python3 app.py` starts the app at `http://127.0.0.1:8080`. Use `--port 8081` to choose another port.
- `python3 -m py_compile app.py tracker.py git_reference.py` checks Python syntax.
- `python3 git_reference.py --task 1 --repo /path/to/repo --ticket PROJ-123` imports Git reference dates for task 1. Set `TASK_GANTT_DB` to the same path for the CLI and server when using a custom database.

## Coding Style and Naming

Use four spaces in Python and two in JavaScript, HTML, and CSS. Match existing names with `snake_case` for Python functions and JSON fields, `camelCase` for JavaScript functions and variables, and `kebab-case` for CSS classes and HTML IDs. Keep user-facing strings in Japanese and preserve Japan Standard Time and Monday-start weeks in date logic. The project has no configured formatter or linter.

## Testing Guidelines

The project has no automated suite or coverage target. Point `TASK_GANTT_DB` at a disposable SQLite file for manual tests. Create and edit a task, start it, hold and resume it, then finish it. Check that the timeline and day, week, and month totals reflect those changes. For import changes, confirm that Git reference dates appear and actual work dates are preserved.

## Commits and Pull Requests

Use a short, imperative commit subject such as `Fix weekly effort totals`. In the pull request, describe the behavior change, list the checks you ran, link any related issue, and attach screenshots for visible UI changes.
