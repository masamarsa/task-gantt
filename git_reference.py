"""Import commit reference dates from a local Git repository."""

import argparse
import re
import subprocess
from datetime import datetime
from pathlib import Path

import tracker


def read_reference(repository, ticket):
    # Match a complete ticket token, so PROJ-12 does not include PROJ-123.
    key = re.compile(rf"(?<![\w-]){re.escape(ticket)}(?![\w-])")
    result = subprocess.run(
        ["git", "-C", str(repository), "log", "--all", "--format=%H%x00%cI%x00%B%x00"],
        check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    records = iter(result.stdout.split("\0"))
    matches = sorted(
        (int(datetime.fromisoformat(stamp).timestamp()), commit.strip())
        for commit, stamp, message in zip(records, records, records)
        if key.search(message)
    )
    reference = {"repository": repository.name or str(repository), "ticket": ticket, "commit_count": len(matches)}
    if matches:
        reference["first_at"], reference["first_hash"] = matches[0]
        reference["last_at"], reference["last_hash"] = matches[-1]
    return reference


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, type=int, help="タスクID")
    parser.add_argument("--repo", required=True, type=Path, help="ローカルGitリポジトリ")
    parser.add_argument("--ticket", required=True, help="コミットメッセージ内のチケットキー（例 PROJ-123）")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*", args.ticket) or len(args.ticket) > 80:
        parser.error("チケットキーは80文字以内の半角英数字、ハイフン、アンダースコアで入力してください。")
    tracker.initialize()
    try:
        with tracker.database() as connection:
            tracker.find_task(connection, args.task)
        reference = read_reference(args.repo.resolve(), args.ticket)
        tracker.update_git_reference(args.task, reference)
    except (tracker.Invalid, OSError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"取込失敗: {exc}\n")
    print(f"タスク #{args.task} に {reference['commit_count']} 件のコミットを取り込みました。")


if __name__ == "__main__":
    main()
