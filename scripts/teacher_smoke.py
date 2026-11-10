#!/usr/bin/env python3
"""End-to-end smoke for the teacher slices: accounts, isolation, task board,
knowledge import, and shell routing — against a real WSGI server.

Run from the repo root:

    python3 scripts/teacher_smoke.py

Exits non-zero on the first failed assertion. Uses a throwaway HOME and data
root, so it never touches the developer's real workspace or accounts.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from wsgiref.simple_server import WSGIRequestHandler, make_server

ROOT = pathlib.Path(__file__).resolve().parents[1]


class _Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def main() -> int:
    sandbox = pathlib.Path(tempfile.mkdtemp(prefix="teacher-smoke-"))
    os.environ["HOME"] = str(sandbox / "home")
    os.environ["COW_DATA_DIR"] = str(sandbox / "data")
    (sandbox / "home").mkdir(parents=True)
    (sandbox / "data").mkdir(parents=True)
    (sandbox / "data" / "config.json").write_text(json.dumps({
        "channel_type": "web",
        "agent": True,
        "knowledge": True,
        "agent_permission_mode": "full-access",
        "model": "deepseek-flash",
        "web_host": "127.0.0.1",
        "web_port": 0,
    }), encoding="utf-8")
    sys.path.insert(0, str(ROOT))

    from channel.web import web_channel

    app = web_channel.build_app()
    server = make_server("127.0.0.1", 0, app.wsgifunc(), handler_class=_Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    # One opener per call, no cookie jar: a shared jar would let B's session
    # cookie override A's bearer token and silently test the wrong tenant.
    def call(method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(base + path, data=data, method=method)
        if not (headers or {}).get("Content-Type"):
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    checks = []

    def check(name, ok, detail=""):
        checks.append((name, ok))
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" :: {detail}"))
        if not ok:
            raise SystemExit(1)

    try:
        status, body = call("POST", "/api/account/register",
                            {"username": "smoke-a", "password": "smoke-pass-a", "name": "甲老师"})
        check("register teacher A", status == 200 and '"token"' in body, f"{status} {body[:200]}")
        token_a = json.loads(body)["token"]
        auth_a = {"Authorization": f"Bearer {token_a}"}

        status, body = call("POST", "/api/account/register",
                            {"username": "smoke-b", "password": "smoke-pass-b", "name": "乙老师"})
        check("register teacher B", status == 200, f"{status} {body[:200]}")
        token_b = json.loads(body)["token"]
        agent_b = json.loads(body)["user"]["agent_id"]

        status, body = call("GET", "/api/account/me", headers=auth_a)
        check("me returns teacher A", status == 200 and "smoke-a" in body, f"{status} {body[:200]}")

        status, body = call("POST", "/api/tasks",
                            {"title": "冒烟任务：备 Unit 3", "due": "2026-11-12", "lane": "七年级英语"},
                            headers=auth_a)
        check("create task as A", status == 200 and '"task"' in body, f"{status} {body[:200]}")

        status, body = call("POST", "/api/tasks",
                            {"title": "B 的任务", "agent_id": agent_b}, headers=auth_a)
        listing = json.loads(call("GET", "/api/tasks", headers=auth_a)[1])
        titles = [t["title"] for t in listing.get("tasks", [])]
        check("account scoping ignores agent_id", "B 的任务" in titles, str(titles))
        listing_b = json.loads(call("GET", "/api/tasks", headers={"Authorization": f"Bearer {token_b}"})[1])
        titles_b = [t["title"] for t in listing_b.get("tasks", [])]
        check("teacher B's board stays empty", titles_b == [], str(titles_b))

        status, body = call("POST", "/api/account/login", {"username": "smoke-a", "password": "smoke-pass-a"})
        check("login with password", status == 200 and '"token"' in body, f"{status} {body[:160]}")
        check("board has 4 columns", [c["status"] for c in listing["board"]["columns"]] == ["todo", "doing", "blocked", "done"],
              str(listing.get("board", {}).get("columns", []))[:120])

        status, body = call("GET", "/home", headers=auth_a)
        check("shell serves /home", status == 200 and 'id="view-home"' in body, f"{status} {body[:120]}")

        boundary = "----smoke"
        payload = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"target_category\"\r\n\r\n教材\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"conflict_strategy\"\r\n\r\nrename\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"Unit-03.md\"\r\n"
            "Content-Type: text/markdown\r\n\r\nUnit 3 My weekend plan\r\n"
            f"--{boundary}--\r\n"
        ).encode()
        status, body = call("POST", "/api/knowledge/import", raw=payload, headers={
            **auth_a, "Content-Type": f"multipart/form-data; boundary={boundary}"})
        check("knowledge import accepts a document", status == 200 and '"imported"' in body, f"{status} {body[:200]}")

        from agent.tools.pptx import build_deck

        out = sandbox / "deck.pptx"
        build_deck({"title": "Unit 3", "theme": "lecture",
                    "slides": [{"title": "目标", "bullets": ["能描述周末计划"]}]}, str(out))
        check("pptx builds offline", out.exists() and out.stat().st_size > 10000, str(out.stat().st_size if out.exists() else 0))

        print(f"\n{len(checks)} checks passed. sandbox: {sandbox}")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(sandbox, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
