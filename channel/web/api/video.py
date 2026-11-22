"""The video download view's endpoints: /api/video/*.

Four things the page needs and nothing else:

- **status** — is the engine there (yt-dlp, ffmpeg, a browser), and which
  accounts are signed in. The header pills and the login card read this.
- **probe** — what is behind a pasted link, before anything is written to disk.
- **download** — one job, streamed as Server-Sent Events. A 4K file can take
  minutes, so a plain POST would hit client and proxy timeouts; the console
  already tails logs over SSE, so this uses the same mechanism and needs no job
  queue.
- **recent / delete** — the page's own history, read from the output directory
  so files downloaded before this view existed show up too.

Login is a separate pair of endpoints (`login/start`, `login/poll`) because the
QR has to be redrawn and polled while the user's phone does the work.
"""

import json
import os

import web

from agent.media.video import platforms, service
from channel.web.core._common import _require_auth

RECENT_LIMIT = 12
VIDEO_SUFFIXES = (".mp4", ".mkv", ".webm", ".mov", ".m4v")


def _json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _ok(**payload) -> str:
    return _json({"status": "success", **payload})


def _fail(code: str, message: str) -> str:
    return _json({"status": "error", "code": code, "message": message})


def _param(name: str, default: str = "") -> str:
    try:
        values = web.input()
        return str(values.get(name, default) or default).strip()
    except Exception:
        return default


def _body() -> dict:
    raw = web.data()
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


class VideoStatusHandler:
    def GET(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            return _ok(**service.status())
        except Exception as e:
            return _fail("unknown", f"状态读取失败：{e}")


class VideoProbeHandler:
    def GET(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        url = _param("url")
        if not url:
            return _fail("bad_request", "缺少 url。")
        try:
            return _ok(**service.probe(url))
        except service.VideoError as e:
            return _fail(e.reason, str(e))
        except Exception as e:
            return _fail("unknown", f"解析失败：{e}")


class VideoDownloadHandler:
    """SSE: {"stage": "probe"|"download"|"done"|"error", ...}

    The download runs on a worker thread and pushes its progress through a
    queue, because `service.download` is blocking: streaming from inside it
    would hold the first frame until the file was already on disk.
    """

    def GET(self):
        _require_auth()
        web.header('Content-Type', 'text/event-stream; charset=utf-8')
        web.header('Cache-Control', 'no-cache')
        web.header('X-Accel-Buffering', 'no')

        url = _param("url")
        quality = _param("quality", "best") or "best"
        source = _param("source")
        title = _param("title")
        try:
            max_mb = int(_param("max_mb", str(service.DEFAULT_MAX_MB)))
        except ValueError:
            max_mb = service.DEFAULT_MAX_MB

        def frame(payload: dict) -> bytes:
            return ("data: " + _json(payload) + "\n\n").encode("utf-8")

        def generate():
            if not url:
                yield frame({"stage": "error", "reason": "bad_request", "message": "缺少 url。"})
                return

            import queue
            import threading

            events = queue.Queue()
            outcome = {}

            def work():
                try:
                    outcome["result"] = service.download(
                        url,
                        quality=quality,
                        max_mb=max_mb,
                        source=source or None,
                        title=title or None,
                        on_event=events.put,
                    )
                except service.VideoError as e:
                    outcome["error"] = {"reason": e.reason, "message": str(e), "detail": e.detail}
                except Exception as e:  # pragma: no cover - defensive
                    outcome["error"] = {"reason": "unknown", "message": str(e)}
                finally:
                    events.put(None)

            threading.Thread(target=work, daemon=True).start()

            while True:
                try:
                    item = events.get(timeout=5)
                except queue.Empty:
                    # Long silent stretches (browser render) still need bytes on
                    # the wire or proxies close the connection.
                    yield b": keepalive\n\n"
                    continue
                if item is None:
                    break
                yield frame(item)

            if outcome.get("error"):
                yield frame({"stage": "error", **outcome["error"]})
            else:
                yield frame({"stage": "done", **(outcome.get("result") or {})})

        return generate()

    def POST(self):
        return self.GET()


class VideoCancelHandler:
    """Stop the running download.

    Closing the EventSource only stops the page from listening; the transfer
    itself would keep going and still write a file. This asks the service to
    abort between chunks.
    """

    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            return _ok(**service.cancel())
        except Exception as e:
            return _fail("unknown", f"取消失败：{e}")


class VideoPosterHandler:
    """GET ``/api/video/poster?path=``: the first frame of a downloaded video.

    Served as an image so a tile can use it directly as ``<img src>``; the file
    is cached per path+mtime, so a list of twelve videos costs one ffmpeg call
    each, once.
    """

    def GET(self):
        _require_auth()
        path = _param("path")
        if not path:
            raise web.notfound()
        try:
            target = _video_path(path)
        except ValueError:
            raise web.notfound()
        poster = service.poster(target)
        if not poster:
            raise web.notfound()
        web.header('Content-Type', 'image/jpeg')
        web.header('Cache-Control', 'public, max-age=86400')
        with open(poster, 'rb') as handle:
            return handle.read()


class VideoThumbHandler:
    """GET ``/api/video/thumb?url=``: a platform cover, fetched server-side.

    The desktop client is a file:// page, where an http image from a CDN is
    blocked outright, so the "cover before playing" has to be served from the
    app's own origin. Only the platforms' thumbnail CDNs are allowed through.
    """

    def GET(self):
        _require_auth()
        data = service.thumb(_param("url"))
        if not data:
            raise web.notfound()
        web.header('Content-Type', 'image/jpeg')
        web.header('Cache-Control', 'public, max-age=86400')
        return data


class VideoRecentHandler:
    def GET(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            return _ok(items=_recent())
        except Exception as e:
            return _fail("unknown", f"读取历史失败：{e}")


def platform_of_name(name: str) -> str:
    """Which platform a downloaded file came from, read off its ``[id]``.

    Both naming schemes carry it: yt-dlp writes ``title [BV1xx].mp4`` and the
    Douyin path now does the same. Kept here so both clients show the same tag
    instead of each re-deriving it.
    """
    import re

    match = re.search(r"\[([A-Za-z0-9]+)\](?:\s*\(\d+\))?\.\w+$", name or "")
    video_id = match.group(1) if match else ""
    if video_id.upper().startswith("BV") or video_id.isdigit() and len(video_id) <= 10:
        return "bilibili"
    if len(video_id) == 24 and all(c in "0123456789abcdefABCDEF" for c in video_id):
        return "xiaohongshu"
    if video_id.isdigit() and len(video_id) >= 15:
        return "douyin"
    return ""


def _recent(limit: int = RECENT_LIMIT):
    from common.state_dir import output_dir

    root = os.path.join(str(output_dir(ensure=True)), "视频下载")
    found = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            if not name.lower().endswith(VIDEO_SUFFIXES):
                continue
            path = os.path.join(base, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            found.append({
                "name": name,
                "path": path,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
                "platform": platform_of_name(name),
            })
    found.sort(key=lambda item: item["mtime"], reverse=True)
    return found[:limit]


class VideoDeleteHandler:
    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        body = _body()
        path = str(body.get("path") or "")
        if not path:
            return _fail("bad_request", "缺少 path。")
        try:
            _delete(path)
        except ValueError as e:
            return _fail("bad_request", str(e))
        except OSError as e:
            return _fail("not_found", f"删除失败：{e}")
        return _ok(deleted=path)


def _video_path(path: str) -> str:
    """A path inside the download tree that names a real video."""
    from common.state_dir import output_dir

    root = os.path.realpath(os.path.join(str(output_dir(ensure=True)), "视频下载"))
    target = os.path.realpath(path)
    if os.path.commonpath([target, root]) != root:
        raise ValueError("只能访问下载目录里的文件。")
    if not os.path.isfile(target) or not target.lower().endswith(VIDEO_SUFFIXES):
        raise ValueError("这不是一个已下载的视频。")
    return target


def _delete(path: str) -> None:
    """Delete one downloaded video, refusing anything outside the output tree."""
    from common.state_dir import output_dir

    root = os.path.realpath(os.path.join(str(output_dir(ensure=True)), "视频下载"))
    target = os.path.realpath(path)
    if os.path.commonpath([target, root]) != root:
        raise ValueError("只能删除下载目录里的文件。")
    if not os.path.isfile(target):
        raise FileNotFoundError(path)
    if not target.lower().endswith(VIDEO_SUFFIXES):
        raise ValueError("这不是视频文件。")
    os.remove(target)


class VideoLoginStartHandler:
    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        body = _body()
        platform = str(body.get("platform") or "").strip()
        if platform not in platforms.PLATFORM_LABELS:
            return _fail("bad_request", "不认识的平台。")
        try:
            return _ok(**service.login_start(platform))
        except Exception as e:
            return _fail(getattr(e, "reason", "unknown"), str(e))


class VideoLoginPollHandler:
    def GET(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        platform = _param("platform")
        key = _param("key")
        if platform not in platforms.PLATFORM_LABELS:
            return _fail("bad_request", "不认识的平台。")
        try:
            return _ok(**service.login_poll(platform, key))
        except Exception as e:
            return _fail(getattr(e, "reason", "unknown"), str(e))

    def POST(self):
        return self.GET()


class VideoLoginCloseHandler:
    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        platform = str(_body().get("platform") or "").strip()
        try:
            return _ok(**service.login_close(platform))
        except Exception as e:
            return _fail(getattr(e, "reason", "unknown"), str(e))


class VideoLogoutHandler:
    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        platform = str(_body().get("platform") or "").strip() or None
        try:
            return _ok(removed=service.logout(platform), **service.status())
        except Exception as e:
            return _fail("unknown", f"退出失败：{e}")
