"""Single-user WSGI application for Python 3.10+."""

import argparse
import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs
from wsgiref.simple_server import make_server

import tracker
from markdown_render import render_markdown

STATIC = Path(__file__).parent / "static"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/markdown-editor.css": ("markdown-editor.css", "text/css; charset=utf-8"),
    "/markdown-editor.js": ("markdown-editor.js", "text/javascript; charset=utf-8"),
}
MAX_BODY = 262144
TASK_ROUTE = re.compile(r"/api/tasks(?:/([1-9][0-9]{0,17})(/status)?)?")


def response(start_response, status, data, content_type):
    start_response(status, [
        ("Content-Type", content_type),
        ("Content-Length", str(len(data))),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                                    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
    ])
    return [data]


def json_response(start_response, status, payload):
    data = json.dumps(payload, ensure_ascii=False).encode()
    return response(start_response, status, data, "application/json; charset=utf-8")


def read_payload(environ):
    if environ.get("CONTENT_TYPE", "").split(";")[0] != "application/json":
        raise tracker.Invalid("JSON形式で送信してください。")
    try:
        length = int(environ.get("CONTENT_LENGTH") or "0")
        if not 0 < length <= MAX_BODY:
            raise ValueError
        payload = json.loads(environ["wsgi.input"].read(length))
        if not isinstance(payload, dict):
            raise ValueError
        return payload
    except (ValueError, RecursionError):
        raise tracker.Invalid("入力データの形式またはサイズが正しくありません。") from None


def check_write_origin(environ):
    # Same-origin JSON writes also work through a reverse proxy preserving the Host header.
    origin = environ.get("HTTP_ORIGIN")
    host = environ.get("HTTP_HOST")
    if origin and origin not in (f"http://{host}", f"https://{host}"):
        raise tracker.Invalid("操作はアプリを開いたページから行ってください。")


def render_task_markdown(payload):
    rendered = {}
    for field in ("description", "approach"):
        source = payload.get(field, "")
        limit = tracker.TEXT_FIELDS[field]
        if not isinstance(source, str) or len(source) > limit:
            raise tracker.Invalid(f"テキストは{limit:,}文字以内で入力してください。")
        if any(0xD800 <= ord(character) <= 0xDFFF for character in source):
            raise tracker.Invalid("入力データの形式が正しくありません。")
        rendered[field] = render_markdown(source)
    return rendered


def application(environ, start_response):
    path, method = environ["PATH_INFO"], environ["REQUEST_METHOD"]
    if method == "GET" and path in ASSETS:
        name, content_type = ASSETS[path]
        return response(start_response, "200 OK", (STATIC / name).read_bytes(), content_type)
    try:
        if path == "/api/markdown" and method == "POST":
            check_write_origin(environ)
            return json_response(start_response, "200 OK", render_task_markdown(read_payload(environ)))
        if path == "/api/dashboard" and method == "GET":
            query = parse_qs(environ.get("QUERY_STRING", ""))
            payload = tracker.dashboard(query.get("view", ["week"])[0], query.get("date", [None])[0])
            return json_response(start_response, "200 OK", payload)
        route = TASK_ROUTE.fullmatch(path)
        if route:
            task_id = int(route[1]) if route[1] else None
            if task_id is None and method == "POST":
                check_write_origin(environ)
                task_id = tracker.write_task(read_payload(environ))
                return json_response(start_response, "201 Created", {"id": task_id})
            if task_id and not route[2] and method == "GET":
                return json_response(start_response, "200 OK", tracker.read_task(task_id))
            if task_id and not route[2] and method == "PATCH":
                check_write_origin(environ)
                revision = tracker.patch_task(task_id, read_payload(environ))
                return json_response(start_response, "200 OK", {"id": task_id, "revision": revision})
            if task_id and ((route[2] and method == "POST") or (not route[2] and method == "PUT")):
                check_write_origin(environ)
                payload = read_payload(environ)
                if route[2]:
                    tracker.change_status(task_id, payload)
                else:
                    tracker.write_task(payload, task_id)
                return json_response(start_response, "200 OK", {"id": task_id})
    except tracker.Missing as exc:
        return json_response(start_response, "404 Not Found", {"error": str(exc)})
    except tracker.Conflict as exc:
        return json_response(start_response, "409 Conflict", {"error": str(exc)})
    except tracker.Invalid as exc:
        return json_response(start_response, "400 Bad Request", {"error": str(exc)})
    return json_response(start_response, "404 Not Found", {"error": "ページが見つかりません。"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="個人用タスク管理アプリ")
    parser.add_argument("--host", default=os.environ.get("TASK_GANTT_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=8080, type=int)
    args = parser.parse_args()
    tracker.initialize()
    with make_server(args.host, args.port, application) as server:
        print(f"Task Gantt → http://{args.host}:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
