#!/usr/bin/env python3
"""Boot the console with a throwaway teacher workspace for UI checks.

    python3 scripts/teacher_dev_server.py --port 8899 [--keep]

State lives in /tmp/teacher-ui (wiped unless --keep) so repeated runs start
from a clean account store. Prints the base URL once it is serving.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import sys
import tempfile

SANDBOX = pathlib.Path(tempfile.gettempdir()) / "teacher-ui"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    if not args.keep:
        shutil.rmtree(SANDBOX, ignore_errors=True)
    (SANDBOX / "home").mkdir(parents=True, exist_ok=True)
    (SANDBOX / "data").mkdir(parents=True, exist_ok=True)
    (SANDBOX / "data" / "config.json").write_text(json.dumps({
        "channel_type": "web",
        "agent": True,
        "knowledge": True,
        "agent_permission_mode": "full-access",
        "model": "deepseek-flash",
        "web_host": "127.0.0.1",
        "web_port": args.port,
    }), encoding="utf-8")

    os.environ["HOME"] = str(SANDBOX / "home")
    os.environ["COW_DATA_DIR"] = str(SANDBOX / "data")
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

    from wsgiref.simple_server import make_server

    from channel.web import web_channel

    app = web_channel.build_app()
    server = make_server("127.0.0.1", args.port, app.wsgifunc())
    print(f"serving http://127.0.0.1:{args.port}  sandbox={SANDBOX}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
