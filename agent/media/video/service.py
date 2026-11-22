"""The video download job: one link in, one finished file in the workspace.

Responsibilities kept out of the platform modules:

- **Serialised.** Downloads share the user's bandwidth and disk, and two at once
  make both slower without helping anyone. One lock, and a second caller is told
  "busy" instead of being queued invisibly.
- **Bounded.** A hard size cap and a wall-clock timeout; the free-space check
  happens before the first byte so a full disk fails fast instead of halfway.
- **Paced.** Every long step reports progress on one event stream, which is what
  both the chat card and the page's progress bar consume.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from datetime import date
from typing import Callable, Dict, Optional

from agent.media.video import credentials, douyin, login, platforms, runner
from common.log import logger

DEFAULT_MAX_MB = 1024
MAX_MB_LIMIT = 4096

_lock = threading.Lock()
# Set by /api/video/cancel: a download that is already streaming checks this
# between chunks so "取消" stops the transfer instead of only the progress bar.
_cancel = threading.Event()


class VideoError(RuntimeError):
    def __init__(self, reason: str, message: str, detail: str = ""):
        super().__init__(message)
        self.reason = reason
        self.detail = detail


def status() -> Dict:
    """What the page's header and settings card show.

    Asking for status is also what starts a missing engine installing: the page
    polls this endpoint on load, so "open the workbench and it works" needs no
    separate step.
    """
    ready = runner.find_command() is not None
    install = {"running": False, "error": "", "ready": ready}
    if not ready:
        install = runner.ensure_engine()
    return {
        "ytdlp": ready,
        "installing": install.get("running", False),
        "install_error": install.get("error", ""),
        "version": runner.version(),
        "ffmpeg": runner.ffmpeg_location(),
        "browser": douyin.browser_path(),
        "platforms": sorted(platforms.PLATFORM_LABELS.values()),
        "accounts": login.status(),
    }


def login_start(platform: str) -> Dict:
    """Begin a login: Bilibili answers with a QR, the other two open a window."""
    if platform == "bilibili":
        return login.bili_start()
    return login.browser_start(platform)


def login_poll(platform: str, key: str = "") -> Dict:
    if platform == "bilibili":
        return login.bili_poll(key)
    return login.browser_poll(platform)


def login_close(platform: str) -> Dict:
    return login.browser_close(platform)


def logout(platform: Optional[str] = None) -> int:
    return credentials.clear(platform)


def available() -> bool:
    return runner.find_command() is not None


def cancel() -> Dict:
    """Ask the running download to stop. Safe to call when nothing is running."""
    _cancel.set()
    return {"cancelled": True}


def probe(text: str) -> Dict:
    """Preview one link without downloading it."""
    link = platforms.normalize(text)
    info = {"platform": link.platform, "label": link.label, "id": link.video_id, "url": link.url}
    if link.platform == platforms.DOUYIN:
        found = douyin.extract(link.url)
        info.update({
            "title": found["title"],
            "size": _head_size(found["url"]),
            "source": found["url"],
            "via": "browser",
        })
        return info
    info.update(runner.probe(link.url))
    info["via"] = "yt-dlp"
    return info


def _head_size(url: str) -> Optional[int]:
    """Content-Length of a resolved stream, so the page can show a size."""
    import requests

    try:
        response = requests.head(
            url,
            headers={"User-Agent": platforms.UA, "Referer": "https://www.douyin.com/"},
            timeout=(5, 15),
            allow_redirects=True,
        )
        response.close()
        return int(response.headers.get("Content-Length") or 0) or None
    except Exception as e:
        logger.debug(f"[video] head failed for {url[:60]}: {e}")
        return None


def download(
    text: str,
    quality: str = "best",
    max_mb: int = DEFAULT_MAX_MB,
    on_event: Optional[Callable[[Dict], None]] = None,
    source: Optional[str] = None,
    title: Optional[str] = None,
) -> Dict:
    """Download one video and return {path, title, size, platform}.

    ``source``/``title`` are the values `probe` already found, so the page can
    preview and then download without fetching the page twice.
    """
    max_mb = _clamp_size(max_mb)
    if not _lock.acquire(blocking=False):
        raise VideoError("busy", "已经有一个视频在下载了，等它结束再试。")
    try:
        _cancel.clear()
        link = platforms.normalize(text)
        out_dir = _output_dir()
        _check_disk(out_dir, max_mb)
        _emit(on_event, {"stage": "probe", "title": title or "", "platform": link.platform})

        if link.platform == platforms.DOUYIN:
            result = _download_douyin(link, out_dir, max_mb, on_event, source, title)
        else:
            result = runner.download(
                link.url,
                out_dir,
                quality=quality,
                max_mb=max_mb,
                on_event=lambda event: _emit(on_event, event),
                should_stop=_cancel.is_set,
            )

        result.update({"platform": link.platform, "url": link.url, "video_id": link.video_id})
        # No "done" event here: the caller builds it from the returned dict, and
        # emitting our own too produced two identical frames on the SSE stream.
        logger.info(
            f"[video] {link.platform} {link.video_id} -> {result['path']} "
            f"({result['size'] // 1024} KB)"
        )
        return result
    except platforms.VideoUrlError as e:
        raise VideoError(getattr(e, "reason", "unsupported"), str(e)) from e
    except runner.RunnerError as e:
        raise VideoError(e.reason, str(e), e.detail) from e
    except douyin.DouyinError as e:
        raise VideoError(e.reason, str(e), e.detail) from e
    finally:
        _lock.release()


def _download_douyin(link, out_dir, max_mb, on_event, source, title) -> Dict:
    if not source and credentials.has_session("douyin"):
        # An imported session lets yt-dlp talk to the API directly: ~2s instead
        # of the ~15s a browser render costs. Any failure falls through to the
        # browser, which needs no account at all.
        try:
            return runner.download(
                link.url, out_dir, max_mb=max_mb,
                on_event=lambda event: _emit(on_event, event),
            )
        except runner.RunnerError as e:
            logger.info(f"[video] douyin via yt-dlp failed ({e.reason}), using browser")

    if not source:
        found = douyin.extract(link.url)
        source, title = found["url"], found["title"]
    path = _fetch_direct(source, out_dir, title or link.video_id, max_mb, on_event,
                         video_id=link.video_id)
    return {
        "path": path,
        "title": title or os.path.splitext(os.path.basename(path))[0],
        "size": os.path.getsize(path),
    }


def _fetch_direct(url: str, out_dir: str, title: str, max_mb: int, on_event,
                  video_id: str = "") -> str:
    """Stream a CDN URL we already resolved into the output directory.

    The file name carries ``[id]`` like yt-dlp's own output, because 最近下载
    works out which platform a file came from by that id: without it a Douyin
    download showed up with no platform tag at all.
    """
    import requests

    stem = _safe_name(title)
    name = f"{stem} [{video_id}].mp4" if video_id else stem + ".mp4"
    final = _unique_path(os.path.join(out_dir, name))
    limit = max_mb * 1024 * 1024
    started = time.time()
    done = 0

    headers = {"User-Agent": platforms.UA, "Referer": "https://www.douyin.com/", "Accept": "*/*"}
    try:
        response = requests.get(url, headers=headers, stream=True, timeout=(10, 60))
    except Exception as e:
        raise VideoError("network", "视频地址连不上，可能已过期，重试一次。", str(e)) from e

    if response.status_code >= 400:
        response.close()
        raise VideoError("not_found", f"视频地址返回 {response.status_code}，可能已过期。")

    total = int(response.headers.get("Content-Length") or 0)
    tmp = final + ".part"
    try:
        with open(tmp, "wb") as handle:
            for chunk in response.iter_content(262144):
                if _cancel.is_set():
                    raise VideoError("cancelled", "已取消。")
                if not chunk:
                    continue
                done += len(chunk)
                if done > limit:
                    raise VideoError("too_large", f"视频超过 {max_mb} MB 上限，已停止。")
                handle.write(chunk)
                elapsed = max(0.001, time.time() - started)
                _emit(on_event, {
                    "stage": "download",
                    "percent": round(done * 100.0 / total, 1) if total else None,
                    "speed": f"{done / elapsed / 1048576:.1f} MB/s",
                    "eta": f"{int((total - done) / max(1.0, done / elapsed))} 秒" if total else "",
                    "downloaded": done,
                    "total": total,
                })
    except VideoError:
        _discard(tmp)
        raise
    except Exception as e:
        _discard(tmp)
        raise VideoError("network", "下载中断。", str(e)) from e
    finally:
        response.close()

    os.replace(tmp, final)
    return final


# Thumbnails the platforms publish for a video, by CDN host. The desktop
# renderer runs from file://, where a plain http:// image is blocked, so the
# cover has to come through our own origin.
THUMB_HOSTS = (
    "hdslb.com",
    "xhscdn.com",
    "douyinpic.com",
    "douyinstatic.com",
    "byteimg.com",
    "pstatp.com",
)


def thumb(url: str) -> Optional[bytes]:
    """Fetch a platform thumbnail through the backend, cached by URL."""
    import hashlib
    from urllib.parse import urlparse

    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if not any(host == h or host.endswith("." + h) for h in THUMB_HOSTS):
        return None

    from common.media_download import download_bytes

    cache_dir = os.path.join(_tmp_root(), "video-thumbs")
    os.makedirs(cache_dir, exist_ok=True)
    target = os.path.join(cache_dir, hashlib.sha1(url.encode()).hexdigest() + ".img")
    if os.path.isfile(target) and os.path.getsize(target) > 0:
        with open(target, "rb") as handle:
            return handle.read()
    try:
        data = download_bytes(url, max_bytes=5 * 1024 * 1024, timeout=(5, 15), guarded=True)
    except Exception as e:
        logger.debug(f"[video] thumbnail fetch failed: {e}")
        return None
    if not data:
        return None
    with open(target, "wb") as handle:
        handle.write(data)
    return data


def poster(path: str) -> Optional[str]:
    """A JPEG of the video's first frame, cached by path+mtime.

    The tile in 最近下载 used to be a film icon because nothing knew what the
    file looked like. One ffmpeg call per file, cached under the workspace tmp
    dir, and the page can show the actual frame — including for videos that were
    downloaded before this existed.
    """
    import hashlib

    ffmpeg = runner.ffmpeg_location()
    if not ffmpeg or not os.path.isfile(path):
        return None
    try:
        stamp = f"{os.path.realpath(path)}:{os.path.getmtime(path):.0f}"
    except OSError:
        return None
    cache_dir = os.path.join(_tmp_root(), "video-posters")
    os.makedirs(cache_dir, exist_ok=True)
    target = os.path.join(cache_dir, hashlib.sha1(stamp.encode()).hexdigest() + ".jpg")
    if os.path.isfile(target) and os.path.getsize(target) > 0:
        return target

    # 0.5s in: a lot of clips open on a black frame, and a black tile is no
    # better than the icon it replaces.
    command = [
        ffmpeg, "-y", "-v", "error", "-ss", "0.5", "-i", path,
        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", target,
    ]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=20)
    except Exception as e:
        logger.debug(f"[video] poster failed for {path}: {e}")
        return None
    if result.returncode != 0 or not os.path.isfile(target) or not os.path.getsize(target):
        logger.debug(f"[video] poster ffmpeg failed: {result.stderr[:200]}")
        return None
    return target


def _tmp_root() -> str:
    from common.state_dir import tmp_dir

    return str(tmp_dir(ensure=True))


def _output_dir() -> str:
    from common.state_dir import output_dir

    path = os.path.join(str(output_dir(ensure=True)), "视频下载", date.today().isoformat())
    os.makedirs(path, exist_ok=True)
    return path


def _clamp_size(max_mb) -> int:
    try:
        value = int(max_mb)
    except (TypeError, ValueError):
        return DEFAULT_MAX_MB
    return max(1, min(value, MAX_MB_LIMIT))


def _check_disk(out_dir: str, max_mb: int) -> None:
    try:
        free = os.statvfs(out_dir).f_bavail * os.statvfs(out_dir).f_frsize
    except AttributeError:
        import shutil

        free = shutil.disk_usage(out_dir).free
    if free < max_mb * 1024 * 1024:
        raise VideoError("disk", "磁盘空间不够，先清理一下再下载。")


def _emit(on_event, event: Dict) -> None:
    if not on_event:
        return
    try:
        on_event(event)
    except Exception as e:
        logger.debug(f"[video] event callback failed: {e}")


def _safe_name(title: str) -> str:
    import re

    cleaned = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", title or "").strip(" .")
    return (cleaned or "douyin")[:80]


def _unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    for i in range(2, 100):
        candidate = f"{stem} ({i}){ext}"
        if not os.path.exists(candidate):
            return candidate
    return path


def _discard(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
