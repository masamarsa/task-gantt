"""SQLite persistence, task transitions and period statistics."""

import os
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, DecimalException
from pathlib import Path

from japanese_holidays import is_public_holiday, public_holidays

JST = timezone(timedelta(hours=9))
JST_EPOCH = datetime(1970, 1, 1, 9, tzinfo=JST)
WORK_WINDOWS = ((9 * 3600, 12 * 3600), (13 * 3600, 18 * 3600))
WORKDAY_SECONDS = sum(end - start for start, end in WORK_WINDOWS)
DATABASE = Path(os.environ.get("TASK_GANTT_DB", Path(__file__).parent / "data/tracker.sqlite3"))
STATUSES = {"ready": "未開始", "started": "開始", "held": "保留", "resumed": "再開", "finished": "終了"}
TRANSITIONS = {
    "ready": ("started",),
    "started": ("held", "finished"),
    "held": ("resumed", "finished"),
    "resumed": ("held", "finished"),
    "finished": ("resumed",),
}
WORK_EVENT_FILTER = "status IN ('held', 'resumed', 'previous_finish')"
TEXT_FIELDS = {"title": 160, "description": 12000, "approach": 12000}
DATE_FIELDS = tuple(f"{kind}_{edge}" for kind in ("goal", "plan", "actual") for edge in ("start", "end"))
HOUR_FIELDS = ("plan_hours", "ai_hours", "actual_hours")
EDITABLE = (*TEXT_FIELDS, *DATE_FIELDS, *HOUR_FIELDS)
SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    approach TEXT NOT NULL,
    goal_start INTEGER, goal_end INTEGER,
    plan_start INTEGER, plan_end INTEGER,
    actual_start INTEGER, actual_end INTEGER,
    plan_hours INTEGER, ai_hours INTEGER, actual_hours INTEGER,
    status TEXT NOT NULL CHECK (status IN ('ready', 'started', 'held', 'resumed', 'finished')),
    revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
CREATE TABLE IF NOT EXISTS git_refs (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    ticket TEXT NOT NULL,
    commit_count INTEGER NOT NULL,
    first_at INTEGER, last_at INTEGER,
    first_hash TEXT, last_hash TEXT
);
"""


class Invalid(ValueError):
    pass


class Missing(Invalid):
    pass


class Conflict(Invalid):
    pass


@contextmanager
def database(write=False):
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        with connection:
            yield connection
    finally:
        connection.close()


def initialize():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    try:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)
    finally:
        connection.close()


def now_timestamp():
    return int(datetime.now(JST).timestamp())


def parse_date(raw):
    if raw in (None, ""):
        return None
    try:
        if isinstance(raw, str) and raw.endswith("+09:00"):
            raw = raw[:-6]
        if not isinstance(raw, str) or len(raw) not in (16, 19):
            raise ValueError
        return int(datetime.strptime(raw, "%Y-%m-%dT%H:%M" if len(raw) == 16 else "%Y-%m-%dT%H:%M:%S")
                   .replace(tzinfo=JST).timestamp())
    except (ValueError, OverflowError):
        raise Invalid("日時を正しい形式で入力してください。") from None


def as_jst(stamp):
    return JST_EPOCH + timedelta(seconds=stamp)


def display_date(stamp):
    if stamp is None:
        return None
    return as_jst(stamp).isoformat(timespec="seconds")


def parse_hours(raw):
    if raw in (None, ""):
        return None
    try:
        hours = Decimal(str(raw))
        if not hours.is_finite() or not 0 <= hours <= 100000:
            raise ValueError
        cents = hours * 100
        if cents != cents.to_integral_value():
            raise ValueError
        return int(cents)
    except (DecimalException, ValueError):
        raise Invalid("工数は0〜100,000の範囲で、小数第2位までの時間を入力してください。") from None


def display_hours(cents):
    return None if cents is None else cents / 100


def fields_from(payload, current=None):
    values = {field: current[field] for field in EDITABLE} if current is not None else {}
    for field, limit in TEXT_FIELDS.items():
        if current is not None and field not in payload:
            continue
        raw = payload.get(field, "")
        if not isinstance(raw, str) or len(raw) > limit:
            raise Invalid(f"テキストは{limit:,}文字以内で入力してください。")
        values[field] = raw.strip()
    if not values["title"]:
        raise Invalid("題名を入力してください。")
    for fields, parse in ((DATE_FIELDS, parse_date), (HOUR_FIELDS, parse_hours)):
        values.update({field: parse(payload.get(field)) for field in fields if current is None or field in payload})
    for label, kind in (("目標", "goal"), ("予定", "plan"), ("実績", "actual")):
        start, end = values[f"{kind}_start"], values[f"{kind}_end"]
        if start is not None and end is not None and end < start:
            raise Invalid(f"{label}終了日時は開始日時以降にしてください。")
    if values["actual_end"] is not None and values["actual_start"] is None:
        raise Invalid("実績終了日時を入力するには、実績開始日時も必要です。")
    now = now_timestamp()
    if any(values[key] is not None and values[key] > now for key in ("actual_start", "actual_end")):
        raise Invalid("実績日時には現在以前の日時を入力してください。")
    return values


def validate_plan_range(fields):
    goal_start, goal_end = fields["goal_start"], fields["goal_end"]
    for label, planned in (("予定開始", fields["plan_start"]), ("予定終了", fields["plan_end"])):
        if planned is None:
            continue
        # Match the date picker's minute precision, including for timestamps saved with seconds.
        if goal_start is not None and planned // 60 < goal_start // 60:
            raise Invalid(f"{label}日時は目標開始日時以降にしてください。")
        if goal_end is not None and planned // 60 > goal_end // 60:
            raise Invalid(f"{label}日時は目標終了日時以前にしてください。")


def find_task(connection, task_id):
    row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise Missing("タスクが見つかりません。")
    return dict(row)


def require_revision(task, payload):
    if type(payload.get("revision")) is not int or payload["revision"] != task["revision"]:
        raise Conflict("別の操作でタスクが更新されました。画面を閉じ、開き直してください。")


def write_task(payload, task_id=None):
    fields = fields_from(payload)
    with database(write=True) as connection:
        if task_id is None:
            validate_plan_range(fields)
            status = "finished" if fields["actual_end"] is not None else (
                "started" if fields["actual_start"] is not None else "ready")
            fields["status"] = status
            columns = ", ".join(fields)
            placeholders = ", ".join("?" for _ in fields)
            return connection.execute(
                f"INSERT INTO tasks ({columns}) VALUES ({placeholders})", tuple(fields.values())
            ).lastrowid

        task = find_task(connection, task_id)
        require_revision(task, payload)
        save_task_changes(connection, task, fields)
        return task_id


def patch_task(task_id, payload):
    unknown = payload.keys() - EDITABLE - {"revision"}
    if unknown:
        raise Invalid("更新できない項目が含まれています。")
    if not payload.keys() & EDITABLE:
        raise Invalid("更新する項目を指定してください。")
    if type(payload.get("revision")) is not int or payload["revision"] < 1:
        raise Invalid("取得したタスクの revision を正の整数で指定してください。")
    with database(write=True) as connection:
        task = find_task(connection, task_id)
        require_revision(task, payload)
        save_task_changes(connection, task, fields_from(payload, task))
        return task["revision"] + 1


def save_task_changes(connection, task, fields):
    # Allow other fields to be edited on legacy tasks until the goal or plan dates are changed.
    if any(fields[key] != task[key] for key in ("goal_start", "goal_end", "plan_start", "plan_end")):
        validate_plan_range(fields)
    start, end = fields["actual_start"], fields["actual_end"]
    events = connection.execute(
        f"SELECT occurred_at FROM events WHERE task_id = ? AND {WORK_EVENT_FILTER}",
        (task["id"],),
    ).fetchall()
    if events and (start is None or any(row[0] < start or (end is not None and row[0] > end) for row in events)):
        raise Invalid("保留・再開の履歴を含む実績日時を入力してください。")
    if task["status"] == "finished" and end is None:
        raise Invalid("終了済みタスクには実績終了日時が必要です。")
    if task["status"] != "ready" and start is None:
        raise Invalid("開始済みタスクには実績開始日時が必要です。")
    status = task["status"]
    if end is not None:
        status = "finished"
    elif start is not None and status == "ready":
        status = "started"
    fields["status"] = status
    assignments = ", ".join(f"{column} = ?" for column in fields)
    connection.execute(
        f"UPDATE tasks SET {assignments}, revision = revision + 1 WHERE id = ?",
        (*fields.values(), task["id"]),
    )


def change_status(task_id, payload):
    with database(write=True) as connection:
        task = find_task(connection, task_id)
        require_revision(task, payload)
        status = payload.get("status")
        if status not in TRANSITIONS[task["status"]]:
            raise Invalid("この状態には変更できません。")
        last_event = connection.execute(
            f"SELECT MAX(occurred_at) FROM events WHERE task_id = ? AND {WORK_EVENT_FILTER}",
            (task_id,),
        ).fetchone()[0]
        now = max(now_timestamp(), task["actual_start"] or 0, task["actual_end"] or 0, last_event or 0)
        start = now if status == "started" else task["actual_start"]
        end = task["actual_end"]
        if status == "finished":
            end = now
        elif task["status"] == "finished":
            # Save the effective end, including any edits made after the last finish event.
            connection.execute(
                "INSERT INTO events (task_id, status, occurred_at) VALUES (?, 'previous_finish', ?)",
                (task_id, end),
            )
            end = None
        connection.execute(
            "UPDATE tasks SET status = ?, actual_start = ?, actual_end = ?, revision = revision + 1 WHERE id = ?",
            (status, start, end, task_id),
        )
        connection.execute(
            "INSERT INTO events (task_id, status, occurred_at) VALUES (?, ?, ?)", (task_id, status, now)
        )


def update_git_reference(task_id, reference):
    columns = ("repository", "ticket", "commit_count", "first_at", "last_at", "first_hash", "last_hash")
    with database(write=True) as connection:
        find_task(connection, task_id)
        connection.execute(
            "INSERT OR REPLACE INTO git_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (task_id, *(reference.get(column) for column in columns)),
        )


def work_intervals(task, events, now):
    cursor = task["actual_start"]
    if cursor is None:
        return []
    intervals = []
    for event in events:
        stamp = event["occurred_at"]
        if event["status"] in ("held", "previous_finish"):
            if cursor is not None:
                intervals.append((cursor, stamp))
            cursor = None
        elif event["status"] == "resumed":
            cursor = stamp
    if cursor is not None:
        intervals.append((cursor, task["actual_end"] if task["actual_end"] is not None else max(now, cursor)))
    return intervals


def period_bounds(view, anchor):
    if view == "day":
        return anchor, anchor + timedelta(days=1)
    if view == "week":
        start = anchor - timedelta(days=anchor.weekday())
        return start, start + timedelta(days=7)
    if view == "month":
        start = anchor.replace(day=1)
        return start, (start + timedelta(days=32)).replace(day=1)
    raise Invalid("表示期間は日・週・月から選んでください。")


def at_midnight(day):
    return int(datetime.combine(day, time.min, JST).timestamp())


def working_day_seconds(day, start, end):
    if day.weekday() >= 5 or is_public_holiday(day):
        return 0
    midnight = at_midnight(day)
    return sum(max(0, min(end, midnight + right) - max(start, midnight + left))
               for left, right in WORK_WINDOWS)


def working_days(start, end):
    """Count working days in the half-open range without iterating over each day."""
    weeks, remainder = divmod((end - start).days, 7)
    weekdays = weeks * 5 + sum((start.weekday() + offset) % 7 < 5 for offset in range(remainder))
    holidays = sum(start <= holiday < end and holiday.weekday() < 5
                   for year in range(start.year, end.year + 1) for holiday in public_holidays(year))
    return weekdays - holidays


def working_seconds(start, end):
    if start >= end:
        return 0
    first = as_jst(start).date()
    last = as_jst(end).date()
    seconds = working_day_seconds(first, start, end)
    if first < last:
        seconds += working_day_seconds(last, start, end)
        seconds += working_days(first + timedelta(days=1), last) * WORKDAY_SECONDS
    return seconds


def serialize_task(task, reference, intervals, worked_seconds):
    result = task.copy()
    for field in DATE_FIELDS:
        result[field] = display_date(task[field])
    for field in HOUR_FIELDS:
        result[field] = display_hours(task[field])
    result["work_intervals"] = [[display_date(start), display_date(end)] for start, end in intervals]
    result["tracked_hours"] = round(worked_seconds / 3600, 2)
    if reference:
        result["git"] = dict(reference, first_at=display_date(reference["first_at"]),
                             last_at=display_date(reference["last_at"]))
    else:
        result["git"] = None
    return result


def read_task(task_id):
    with database() as connection:
        task = find_task(connection, task_id)
        reference = connection.execute("SELECT * FROM git_refs WHERE task_id = ?", (task_id,)).fetchone()
        events = connection.execute(
            f"SELECT * FROM events WHERE task_id = ? AND {WORK_EVENT_FILTER} ORDER BY occurred_at, id",
            (task_id,),
        ).fetchall()
    intervals = work_intervals(task, events, now_timestamp())
    return serialize_task(task, reference, intervals, sum(working_seconds(*interval) for interval in intervals))


def statistics(rows, start, end, now):
    def in_period(stamp):
        return stamp is not None and start <= stamp < end

    actual = 0.0
    completed = []
    started = 0
    for task, intervals, worked in rows:
        if in_period(task["actual_start"]):
            started += 1
        if in_period(task["actual_end"]):
            completed.append((task, worked))
        portion = sum(working_seconds(max(left, start), min(right, end)) for left, right in intervals)
        if task["actual_hours"] is None:
            actual += portion / 3600
        elif worked:
            actual += display_hours(task["actual_hours"]) * portion / worked
        else:
            stamp = next((task[key] for key in ("actual_end", "actual_start") if task[key] is not None), None)
            if in_period(stamp):
                actual += display_hours(task["actual_hours"])

    def compared_hours(key):
        pairs = []
        for task, worked in completed:
            if task[key] is None:
                continue
            measured = (display_hours(task["actual_hours"]) if task["actual_hours"] is not None
                        else worked / 3600)
            pairs.append((display_hours(task[key]), measured))
        expected = sum(pair[0] for pair in pairs)
        measured = sum(pair[1] for pair in pairs)
        return {"count": len(pairs), "expected": round(expected, 2), "actual": round(measured, 2),
                "difference": round(measured - expected, 2)}

    def compared_dates(kind, edge):
        eligible = ((task for task, _ in completed) if edge == "end"
                    else (task for task, _, _ in rows if in_period(task["actual_start"])))
        key = f"{kind}_{edge}"
        differences = [
            task[f"actual_{edge}"] - task[key] for task in eligible if task[key] is not None
        ]
        return {
            "count": len(differences), "late": sum(delta > 0 for delta in differences),
            "average_hours": round(sum(differences) / len(differences) / 3600, 2) if differences else None,
        }

    return {
        "started": started, "finished": len(completed), "actual_hours": round(actual, 2),
        "open": sum(task["actual_end"] is None for task, _, _ in rows),
        "plan": compared_hours("plan_hours"), "ai": compared_hours("ai_hours"),
        "dates": {f"{kind}_{edge}": compared_dates(kind, edge)
                  for kind in ("goal", "plan") for edge in ("start", "end")},
        "now": display_date(now),
    }


def dashboard(view, raw_date):
    try:
        anchor = date.fromisoformat(raw_date) if raw_date else datetime.now(JST).date()
        if not 1900 <= anchor.year <= 9998:
            raise ValueError
    except (ValueError, TypeError):
        raise Invalid("表示する日付を正しく指定してください。") from None
    start, end = period_bounds(view, anchor)
    with database() as connection:
        tasks = [dict(row) for row in connection.execute("SELECT * FROM tasks ORDER BY id DESC")]
        references = {row["task_id"]: dict(row) for row in connection.execute("SELECT * FROM git_refs")}
        events = {}
        for row in connection.execute(
            f"SELECT * FROM events WHERE {WORK_EVENT_FILTER} ORDER BY occurred_at, id"
        ):
            events.setdefault(row["task_id"], []).append(row)
    now = now_timestamp()
    rows = []
    for task in tasks:
        intervals = work_intervals(task, events.get(task["id"], ()), now)
        worked = sum(working_seconds(*interval) for interval in intervals)
        rows.append((task, intervals, worked))
    summary = statistics(rows, at_midnight(start), at_midnight(end), now)
    result_tasks = [serialize_task(task, references.get(task["id"]), intervals, worked)
                    for task, intervals, worked in rows]
    return {
        "tasks": result_tasks, "statuses": STATUSES, "transitions": TRANSITIONS,
        "summary": summary, "period": {"anchor": str(anchor), "start": str(start), "end": str(end)},
    }
