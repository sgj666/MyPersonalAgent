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
        result = build_deck({"version": 1, "meta": {"title": "Unit 3"}, "theme": "lecture",
                             "slides": [{"layout": "objectives", "title": "目标",
                                         "bullets": ["能描述周末计划"]}]}, str(out))
        assert result["path"] == str(out.resolve()) and result["pages"] == 1
        check("pptx builds offline", out.exists() and out.stat().st_size > 10000, str(out.stat().st_size if out.exists() else 0))

        # ---- teaching academics: class -> students -> timetable -> homework -> exam -> analysis
        status, body = call("POST", "/api/teaching/classes",
                            {"name": "七年级1班", "grade": "七年级", "subject": "英语"}, headers=auth_a)
        check("create class", status == 200 and '"class"' in body, f"{status} {body[:160]}")
        class_id = json.loads(body)["class"]["id"]

        roster = [{"no": "%02d" % i, "name": "学生%02d" % i} for i in range(1, 11)]
        status, body = call("POST", "/api/teaching/students",
                            {"class_id": class_id, "students": roster}, headers=auth_a)
        report = json.loads(body)
        check("import 10 students", status == 200 and report.get("imported") == 10, f"{status} {body[:200]}")

        status, body = call("GET", "/api/teaching/students?class_id=" + class_id, headers=auth_a)
        students = json.loads(body)["students"]
        check("roster reads back", len(students) == 10, str(len(students)))

        status, body = call("PUT", "/api/teaching/timetable", {
            "periods": [{"index": 1, "start": "08:00", "end": "08:45"}],
            "slots": [{"class_id": class_id, "weekday": 1, "period": 1,
                       "subject": "英语", "kind": "正课"}],
            "overrides": [],
        }, headers=auth_a)
        check("timetable saves", status == 200 and "slots" in body, f"{status} {body[:160]}")

        status, body = call("POST", "/api/teaching/homework", {
            "class_ids": [class_id], "title": "Unit 3 练习", "kind": "practice", "due": "2026-11-13",
        }, headers=auth_a)
        check("create homework", status == 200 and "item" in body, f"{status} {body[:200]}")
        hw_id = json.loads(body)["item"]["id"]
        status, body = call("PUT", f"/api/teaching/homework/{hw_id}/records",
                            {"records": {students[0]["id"]: "missing"}}, headers=auth_a)
        check("homework records save", status == 200, f"{status} {body[:160]}")

        status, body = call("POST", "/api/teaching/exams", {
            "name": "单元测", "class_ids": [class_id], "subject": "英语",
            "full_score": 100, "date": "2026-11-10",
            "items": [{"key": "reading", "label": "阅读", "full": 40},
                      {"key": "writing", "label": "写作", "full": 20}],
        }, headers=auth_a)
        check("create exam", status == 200 and '"exam"' in body, f"{status} {body[:200]}")
        exam_id = json.loads(body)["exam"]["id"]

        marks = {}
        for index, student in enumerate(students):
            reading = 20 + index * 2          # 20..38 of 40
            writing = 8 + (index % 5) * 2     # 8..16 of 20
            marks[student["id"]] = {"total": reading + writing,
                                    "items": {"reading": reading, "writing": writing}}
        status, body = call("PUT", f"/api/teaching/scores/{exam_id}", {"scores": marks}, headers=auth_a)
        check("scores save", status == 200, f"{status} {body[:160]}")

        status, body = call("GET", f"/api/teaching/analysis?exam_id={exam_id}", headers=auth_a)
        report = json.loads(body)
        summary = report.get("summary") or {}
        check("analysis computes", status == 200 and summary.get("scored") == 10
              and 30 <= summary.get("average", 0) <= 90 and len(report.get("items") or []) == 2,
              f"{status} {json.dumps(summary, ensure_ascii=False)[:200]}")
        check("analysis compares the class", len(report.get("by_class") or []) == 1, str(report.get("by_class"))[:120])

        # --- the teaching tools' pipeline: facts -> draft -> render --------
        # The card and the deck are what the teacher actually ships, so the
        # smoke walks the real path: JSON draft in, files out.
        status, body = call("GET", f"/api/teaching/facts?class_id={class_id}&unit=Unit%203", headers=auth_a)
        facts = json.loads(body)
        keys = [f["key"] for f in facts.get("facts", [])]
        # No progress rows exist yet, so the gap only shows up after the plan
        # import below; homework and exam evidence is already there.
        check("facts read homework and exam evidence",
              status == 200 and {"homework_missing", "exam_avg", "exam_weak"} <= set(keys),
              f"{status} {keys}")
        check("facts carry the class size", facts.get("stats", {}).get("students") == 10,
              str(facts.get("stats"))[:160])

        card = {
            "version": 1,
            "meta": {"class_name": "七(3)班", "class_ids": [class_id], "subject": "英语",
                     "stage": "初中", "book": "人教新版", "unit": "Unit 3",
                     "title": "Unit 3 课后作业", "date": "2026-11-12", "due": "周四", "teacher": "甲老师"},
            "summary": "今晚 20 分钟，重点是 be going to 的三种句型。",
            "sections": [{"heading": "一、词汇巩固", "tier": "basic", "hint": "每题 2 分",
                          "items": [{"no": 1, "type": "fill", "stem": "看望祖父母 ______",
                                     "lines": 1, "answer": "visit grandparents"}]}],
            "footer": {"score": True, "parent_sign": True},
        }
        status, body = call("PUT", "/api/teaching/draft", {"kind": "card", "slug": "smoke-card", "draft": card},
                            headers=auth_a)
        check("card draft saves", status == 200 and "artifacts/教学工具/card/" in body, f"{status} {body[:200]}")

        status, body = call("POST", "/api/teaching/render",
                            {"kind": "card", "draft": card, "out_name": "smoke-card",
                             "formats": ["html", "a4"]}, headers=auth_a)
        rendered = json.loads(body)
        formats = [f["format"] for f in rendered.get("files", [])]
        check("card renders html and a4", status == 200 and formats == ["html", "a4"],
              f"{status} {body[:200]}")
        card_path = pathlib.Path(rendered["files"][0]["path"])
        card_html = card_path.read_text(encoding="utf-8") if card_path.is_file() else ""
        check("card html is self-contained", card_html.startswith("<!doctype html") and "http://" not in card_html
              and "https://" not in card_html, card_html[:120])
        check("card keeps the parent line", "今晚 20 分钟" in card_html, card_html[:120])

        deck = {
            "version": 1, "theme": "lecture",
            "meta": {"title": "Unit 3 My weekend plan", "subtitle": "人教新版 七年级上",
                     "stage": "初中", "subject": "英语", "book": "人教新版", "unit": "Unit 3",
                     "teacher": "甲老师", "date": "2026-11-12"},
            "slides": [
                {"layout": "cover", "title": "Unit 3 My weekend plan", "subtitle": "第 2 课时"},
                {"layout": "objectives", "title": "学习目标", "bullets": ["能说出 5 个短语"]},
                {"layout": "table", "title": "作业分层",
                 "table": {"headers": ["层次", "内容"], "rows": [["基础", "抄写"], ["提升", "写话"]]}},
                {"layout": "end", "title": "谢谢"},
            ],
        }
        status, body = call("POST", "/api/teaching/render",
                            {"kind": "deck", "draft": deck, "out_name": "smoke-deck",
                             "formats": ["pptx", "html"]}, headers=auth_a)
        rendered = json.loads(body)
        files = {f["format"]: f for f in rendered.get("files", [])}
        check("deck renders pptx and html", status == 200 and set(files) == {"pptx", "html"},
              f"{status} {body[:200]}")
        check("deck pptx has every slide", files.get("pptx", {}).get("pages") == 4
              and files["pptx"]["size"] > 10_000, str(files.get("pptx"))[:200])
        check("deck html is offline", "http://" not in pathlib.Path(files["html"]["path"]).read_text(encoding="utf-8"),
              files["html"]["path"])

        status, body = call("GET", "/api/teaching/drafts?kind=card&limit=5", headers=auth_a)
        check("recent card drafts list", status == 200 and "smoke-card" in body, f"{status} {body[:200]}")

        weeks = [{"week": 1, "unit": "Unit 3", "topic": "听说", "periods": 2}] * 1
        status, body = call("POST", "/api/teaching/progress/import",
                            {"class_ids": [class_id], "weeks": weeks}, headers=auth_a)
        imported = json.loads(body)
        check("plan writes into progress", status == 200 and imported.get("created") == 1, body[:200])
        status, body = call("POST", "/api/teaching/progress/import",
                            {"class_ids": [class_id], "weeks": weeks}, headers=auth_a)
        again = json.loads(body)
        check("import is idempotent", again.get("created") == 0 and again.get("skipped") == 1, body[:200])

        status, body = call("GET", f"/api/teaching/facts?class_id={class_id}&unit=Unit%203", headers=auth_a)
        keys = [f["key"] for f in json.loads(body).get("facts", [])]
        check("facts gains the progress gap after the plan lands",
              status == 200 and "progress_gap" in keys, f"{status} {keys}")

        print(f"\n{len(checks)} checks passed. sandbox: {sandbox}")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(sandbox, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
