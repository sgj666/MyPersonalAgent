"""yt-dlp as a subprocess: one CLI, three platforms, no import coupling.

Called as a process rather than imported so that a crashing or wedged extractor
costs us a killed child instead of a wedged agent, and so the same code works
with `pip install yt-dlp`, a self-updated binary, or the `yt-dlp` a user already
has on PATH. Everything here is about turning "some URL" into "one file on
disk", plus translating yt-dlp's English failures into a reason the UI can act
on.

Metadata is deliberately thin: yt-dlp's `-J` is only used to preview a link
(title, size, duration). The download path never trusts values it did not get
from the download itself.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from typing import Callable, Dict, List, Optional, Tuple

from common.log import logger

PROGRESS_PREFIX = "VDL|"
TITLE_PREFIX = "VDT|"
DEFAULT_TIMEOUT = 900

_PROGRESS_TEMPLATE = (
    f"download:{PROGRESS_PREFIX}%(progress._percent_str)s|%(progress._speed_str)s"
    "|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s"
)

_QUALITY_SORT = {"1080": "res:1080", "720": "res:720", "480": "res:480"}
_QUALITY_ALIASES = {"4k": "1080", "2k": "1080"}

# Substrings of yt-dlp's error output, longest match first.
_ERROR_HINTS: Tuple[Tuple[str, str], ...] = (
    ("requested format is not available", "quality"),
    ("fresh cookies", "needs_login"),
    ("log in", "needs_login"),
    ("login", "needs_login"),
    ("sign in to confirm", "needs_login"),
    ("private", "not_found"),
    ("not available", "not_found"),
    ("has been removed", "not_found"),
    ("deleted", "not_found"),
    ("404", "not_found"),
    ("unsupported url", "unsupported_url"),
    ("no video formats", "unsupported_url"),
    ("requested format is not available", "quality"),
    ("timed out", "network"),
    ("connection", "network"),
    ("unable to download", "network"),
    ("got error", "network"),
    ("http error", "network"),
    ("ffmpeg", "dep"),
)


class RunnerError(RuntimeError):
    """A failed yt-dlp run. ``reason`` is what the UI switches on."""

    def __init__(self, reason: str, message: str, detail: str = ""):
        super().__init__(message)
        self.reason = reason
        self.detail = detail


def find_command() -> Optional[List[str]]:
    """The yt-dlp invocation to use, or None when it is not installed."""
    found = shutil.which("yt-dlp")
    if found:
        return [found]
    try:
        import importlib.util

        if importlib.util.find_spec("yt_dlp") is not None:
            if _is_frozen():
                # No interpreter in the bundle: the app binary runs yt-dlp for us
                # (see app.py's --ytdlp branch). `sys.executable -m yt_dlp` would
                # start the backend again — which it did, once, in testing.
                return [sys.executable, "--ytdlp"]
            return [sys.executable, "-m", "yt_dlp"]
    except Exception as e:  # pragma: no cover - import machinery only
        logger.debug(f"[video] yt_dlp import probe failed: {e}")
    bundled = os.path.join(_bin_dir(), "yt-dlp")
    for candidate in (bundled, bundled + ".exe"):
        if os.path.isfile(candidate):
            return [candidate]
    return None


def _work_root() -> str:
    try:
        from common.state_dir import tmp_dir

        root = os.path.join(str(tmp_dir(ensure=True)), "video")
        os.makedirs(root, exist_ok=True)
        return root
    except Exception:
        return os.path.join(os.path.expanduser("~"), ".cow", "tmp", "video")


def _bin_dir() -> str:
    try:
        from common.state_dir import state_root

        return os.path.join(str(state_root()), "bin")
    except Exception:
        return os.path.join(os.path.expanduser("~"), ".cow", "bin")


# ---------------------------------------------------------------------------
# Self-heal: install the engine on first use
# ---------------------------------------------------------------------------

# A workbench that was installed before this feature existed has no yt-dlp, and
# "not ready" with a pip command in a tooltip is not something a teacher should
# have to read. The page loads, asks for status, and the engine installs itself
# in the background while the UI says so. Same mechanism the plugin manager and
# `run.sh` already use; the only new part is that it is not a manual step.
_install_lock = threading.Lock()
_install_state = {"running": False, "error": "", "started_at": 0.0, "last_try": 0.0}
_INSTALL_PACKAGES = ("yt-dlp", "imageio-ffmpeg")
_RETRY_AFTER = 600.0  # seconds between attempts, so a failure is not retried per request


def install_state() -> Dict:
    with _install_lock:
        return {
            "running": _install_state["running"],
            "error": _install_state["error"],
        }


def is_installing() -> bool:
    return install_state()["running"]


def ensure_engine() -> Dict:
    """Start installing yt-dlp when it is missing. Never raises, never blocks.

    Returns the current install state. A second call while an install is running
    is a no-op, and a failed attempt is not retried for ten minutes.
    """
    # yt-dlp alone is not enough: merging a Bilibili stream needs ffmpeg, and a
    # half-installed environment (the engine present, ffmpeg missing) is exactly
    # what produced "缺少 ffmpeg 组件" on a fresh Windows install.
    if find_command() is not None and ffmpeg_location():
        return {"running": False, "error": "", "ready": True}
    if _is_frozen():
        # A PyInstaller bundle has no pip and no writable site-packages. The
        # packaged build freezes the engine in (requirements-desktop.txt), so a
        # missing one means the bundle is damaged, and saying so beats running a
        # pip that cannot exist.
        return {
            "running": False,
            "ready": False,
            "error": ("打包版应内置 yt-dlp 与 ffmpeg；若缺失请重新安装最新版工作台，"
                      "或把 ffmpeg 放到程序目录下。"),
        }
    if os.environ.get("COW_SKIP_AUTO_INSTALL"):
        return {"running": False, "error": "auto install disabled", "ready": False}

    with _install_lock:
        if _install_state["running"]:
            return {"running": True, "error": "", "ready": False}
        if time.time() - _install_state["last_try"] < _RETRY_AFTER and _install_state["error"]:
            return {"running": False, "error": _install_state["error"], "ready": False}
        _install_state.update(running=True, error="", started_at=time.time(), last_try=time.time())

    threading.Thread(target=_install_engine, daemon=True, name="video-engine-install").start()
    return {"running": True, "error": "", "ready": False}


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _install_engine() -> None:
    """`pip install yt-dlp imageio-ffmpeg` into this interpreter, in the background.

    ``imageio-ffmpeg`` carries the static ffmpeg binary, so one install covers
    both halves of "the engine is ready".
    """
    command = [sys.executable, "-m", "pip", "install", *_INSTALL_PACKAGES, "--quiet"]
    logger.info(f"[video] installing the download engine: {' '.join(command)}")
    error = ""
    try:
        result = subprocess.run(
            command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600
        )
        if result.returncode != 0:
            error = (result.stderr or result.stdout or "").strip()[-400:] or f"pip exit {result.returncode}"
    except subprocess.TimeoutExpired:
        error = "pip install timed out"
    except Exception as e:  # pragma: no cover - subprocess only
        error = f"{type(e).__name__}: {e}"

    # pip can exit 0 while the import still fails (a half-removed install, a
    # stale dist-info). Verifying the import is the only way to know, and it
    # stops the retry loop that would otherwise reinstall forever.
    if not error and (find_command() is None or not ffmpeg_location()):
        error = ("pip 报告已安装，但后端仍找不到 yt-dlp 或 ffmpeg；"
                 "执行 pip install --force-reinstall yt-dlp imageio-ffmpeg 重装。")

    with _install_lock:
        _install_state["running"] = False
        _install_state["error"] = error
    if error:
        logger.warning(f"[video] engine install failed: {error}")
    else:
        logger.info(f"[video] engine installed: yt-dlp {version()}")


def version() -> Optional[str]:
    command = find_command()
    if not command:
        return None
    try:
        out = subprocess.run(
            command + ["--version"], capture_output=True, text=True, timeout=20
        )
        return (out.stdout or "").strip() or None
    except Exception as e:
        logger.debug(f"[video] yt-dlp --version failed: {e}")
        return None


def ffmpeg_location() -> Optional[str]:
    """A working ffmpeg, in the order that actually holds on a fresh install.

    1. ``imageio-ffmpeg``'s own copy — pip installs it, and the packaged build
       freezes it in. This is the only one a teacher's machine is guaranteed to
       have; a PATH ffmpeg may be missing entirely or half-broken (a Homebrew
       build whose dylibs went away still answers ``which``).
    2. Next to the executable / in PyInstaller's ``_MEIPASS``, for a bundle that
       ships one as an extra resource instead of a package.
    3. ``<state root>/bin`` — where a self-install or a user drops one.
    4. ``PATH``.
    """
    try:
        import imageio_ffmpeg

        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and os.path.isfile(path):
            return path
    except Exception as e:
        logger.debug(f"[video] imageio-ffmpeg unavailable: {e}")

    names = ("ffmpeg.exe", "ffmpeg") if os.name == "nt" else ("ffmpeg", "ffmpeg.exe")
    roots = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(meipass)
    try:
        roots.append(os.path.dirname(os.path.abspath(sys.executable)))
    except Exception:
        pass
    roots.append(_bin_dir())
    for root in roots:
        for name in names:
            candidate = os.path.join(root, name)
            if os.path.isfile(candidate):
                return candidate
    return shutil.which("ffmpeg")


def probe(url: str, timeout: int = 60) -> Dict:
    """Metadata for one link, without downloading it."""
    command = find_command()
    if not command:
        raise RunnerError("dep", "没有安装 yt-dlp，无法解析链接。")
    args = command + [
        "-J",
        "--no-warnings",
        "--ignore-config",
        "--no-playlist",
        "--socket-timeout",
        "20",
        *_ffmpeg_args(),
        *_cookie_args(),
        url,
    ]
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RunnerError("timeout", "解析超时（平台没有响应）。") from None
    # `-J` writes the JSON even when yt-dlp exits non-zero on a warning (a
    # missing ffmpeg only warns during a probe: nothing gets merged). Trust the
    # JSON first and only report a failure when there is none to read.
    try:
        info = json.loads(out.stdout or "")
    except ValueError:
        if out.returncode != 0:
            raise RunnerError(*_failure(out.stderr or "")) from None
        raise RunnerError("unknown", "解析结果无法识别。", out.stdout[:400]) from None
    return _info_summary(info)


def download(
    url: str,
    out_dir: str,
    quality: str = "best",
    max_mb: int = 1024,
    timeout: int = DEFAULT_TIMEOUT,
    on_event: Optional[Callable[[Dict], None]] = None,
    work_root: Optional[str] = None,
    should_stop: Optional[Callable[[], bool]] = None,
) -> Dict:
    """Download one video into ``out_dir`` and return {path, title, size}.

    yt-dlp writes into a private temp directory under ``out_dir`` and the
    finished file is moved into place afterwards, so a partial download can
    never be mistaken for a finished one and two downloads of the same video
    cannot collide on a half-written file.
    """
    command = find_command()
    if not command:
        raise RunnerError("dep", "没有安装 yt-dlp，无法下载。")

    os.makedirs(out_dir, exist_ok=True)
    # Partials live outside the output directory: nothing half-written should
    # ever look like a deliverable to the artifact scanner.
    root = work_root or _work_root()
    work_dir = os.path.join(root, uuid.uuid4().hex)
    os.makedirs(work_dir, exist_ok=True)

    quality = str(quality or "best").lower()
    quality = _QUALITY_ALIASES.get(quality, quality)
    # Sort by `res` rather than filtering by height: a 1080x1920 vertical video
    # has height 1920, so a `[height<=1080]` filter would silently drop it to
    # the next size down. `res` compares the short side, which is what people
    # mean by "720p" for a phone-shot clip.
    # H.264 first, then the resolution: Windows' built-in player (电影和电视) has
    # no AV1 or HEVC decoder, and Bilibili offers all three codecs at the same
    # size — picking by resolution alone gave files that downloaded fine and
    # then answered "缺少编解码器 0xc00d5212".
    sort = "vcodec:h264"
    if quality in _QUALITY_SORT:
        sort = f"{sort},{_QUALITY_SORT[quality]}"
    sort_args = ["-S", sort]
    args = command + [
        "--no-warnings",
        "--ignore-config",
        "--no-playlist",
        "--playlist-items",
        "1",
        "--no-colors",
        "--newline",
        # `--print` implies quiet, which would swallow the progress lines this
        # whole function exists to forward.
        "--progress",
        "--progress-template",
        _PROGRESS_TEMPLATE,
        "--print",
        f"before_dl:{TITLE_PREFIX}%(title).60B",
        "--print",
        "after_move:filepath",
        "-P",
        f"home:{work_dir}",
        "-o",
        "%(title).60B [%(id)s].%(ext)s",
        "--max-filesize",
        f"{max_mb}M",
        "--socket-timeout",
        "20",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--merge-output-format",
        "mp4",
        "-f",
        "bv*+ba/b",
        *sort_args,
        *_ffmpeg_args(),
        *_cookie_args(),
        url,
    ]

    # A CDN that drops one connection is worth one more whole attempt: the
    # retries inside yt-dlp cover fragments, not a dead host.
    for attempt in (1, 2):
        try:
            title, produced = _run_streaming(args, timeout, on_event, should_stop)
            break
        except RunnerError as e:
            if attempt == 1 and e.reason in ("network", "unknown", "timeout"):
                logger.info(f"[video] retrying after {e.reason}: {e}")
                continue
            shutil.rmtree(work_dir, ignore_errors=True)
            raise

    path = produced or _largest_file(work_dir)
    if not path or not os.path.isfile(path):
        shutil.rmtree(work_dir, ignore_errors=True)
        raise RunnerError("unknown", "下载结束但没有拿到文件。")

    final = _unique_path(os.path.join(out_dir, os.path.basename(path)))
    shutil.move(path, final)
    shutil.rmtree(work_dir, ignore_errors=True)
    return {
        "path": final,
        "title": title or os.path.splitext(os.path.basename(final))[0],
        "size": os.path.getsize(final),
    }


def _run_streaming(args: List[str], timeout: int, on_event,
                   should_stop: Optional[Callable[[], bool]] = None) -> Tuple[str, Optional[str]]:
    """Run yt-dlp, forwarding progress lines; return (title, final filepath).

    stdout and stderr are merged on purpose: with `--print` in play, yt-dlp
    writes progress to stdout and failures to stderr, so reading one pipe
    silently loses either the progress bar or the reason it gave up.
    """
    started = time.time()
    process = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        errors="replace",
    )

    lines: List[str] = []
    title = ""
    produced = None
    try:
        for raw in process.stdout or []:
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            if len(lines) < 200:
                lines.append(line)
            event = _parse_progress(line)
            if event:
                if on_event:
                    _safe_event(on_event, event)
                continue
            candidate = line.strip()
            if candidate.startswith(TITLE_PREFIX):
                title = candidate[len(TITLE_PREFIX):].strip()
            elif _looks_like_path(candidate):
                produced = candidate
            if should_stop and should_stop():
                process.kill()
                raise RunnerError("cancelled", "已取消。")
            if time.time() - started > timeout:
                process.kill()
                raise RunnerError("timeout", "下载超时，已中止。")
        process.wait(timeout=max(5, timeout - int(time.time() - started)))
    finally:
        try:
            (process.stdout or None) and process.stdout.close()
        except Exception:
            pass

    if process.returncode != 0:
        detail = "\n".join(lines)
        logger.debug(f"[video] yt-dlp exit={process.returncode} tail={detail[-800:]}")
        raise RunnerError(*_failure(detail))
    return title, produced


def _looks_like_path(line: str) -> bool:
    lower = line.lower()
    return lower.endswith((".mp4", ".mkv", ".webm", ".m4a", ".mp3", ".flv", ".ts"))


def _parse_progress(line: str) -> Optional[Dict]:
    if not line.startswith(PROGRESS_PREFIX):
        return None
    parts = line[len(PROGRESS_PREFIX):].split("|")
    if len(parts) < 5:
        return None

    def number(text: str) -> Optional[float]:
        match = re.search(r"[\d.]+", (text or "").replace(",", ""))
        return float(match.group(0)) if match else None

    percent = number(parts[0])
    downloaded = number(parts[3])
    total = number(parts[4])
    if not percent and downloaded and total:
        percent = min(100.0, downloaded * 100.0 / total)
    return {
        "stage": "download",
        "percent": round(percent, 1) if percent is not None else None,
        "speed": (parts[1] or "").strip(),
        "eta": (parts[2] or "").strip(),
        "downloaded": int(downloaded or 0),
        "total": int(total or 0),
    }


def _safe_event(on_event, event: Dict) -> None:
    try:
        on_event(event)
    except Exception as e:
        logger.debug(f"[video] progress callback failed: {e}")


def _cookie_args() -> List[str]:
    """Account cookies, when the user has imported any.

    Without a file the request is an ordinary guest one; with it, yt-dlp sends
    the session and the platform answers with the higher-quality stream.
    """
    try:
        from agent.media.video import credentials

        return credentials.ytdlp_cookie_args()
    except Exception as e:
        logger.debug(f"[video] cookie args unavailable: {e}")
        return []


def probe_codec(path: str) -> Dict[str, str]:
    """Video and audio codec of a finished file, read with ffmpeg.

    Used after every download: a container that plays in our own <video> can
    still be unplayable in the operating system's player, and the teacher will
    blame the download rather than the codec.
    """
    ffmpeg = ffmpeg_location()
    if not ffmpeg or not os.path.isfile(path):
        return {}
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", path],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        logger.debug(f"[video] codec probe failed: {e}")
        return {}
    text = (out.stderr or "")
    video = re.search(r"Stream #\d+:\d+.*?: Video: (\w+)", text)
    audio = re.search(r"Stream #\d+:\d+.*?: Audio: (\w+)", text)
    return {"video": video.group(1) if video else "", "audio": audio.group(1) if audio else ""}


def _ffmpeg_args() -> List[str]:
    ffmpeg = ffmpeg_location()
    return ["--ffmpeg-location", ffmpeg] if ffmpeg else []


def _info_summary(info: Dict) -> Dict:
    formats = info.get("formats") or []
    best = None
    for fmt in formats:
        if fmt.get("vcodec") in (None, "none"):
            continue
        if best is None or (fmt.get("height") or 0) > (best.get("height") or 0):
            best = fmt
    size = info.get("filesize") or info.get("filesize_approx")
    if not size and best:
        size = best.get("filesize") or best.get("filesize_approx")
    return {
        "title": (info.get("title") or "").strip(),
        "uploader": (info.get("uploader") or info.get("channel") or "").strip(),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "size": size,
        "width": (best or {}).get("width"),
        "height": (best or {}).get("height"),
        "webpage_url": info.get("webpage_url"),
    }


def _failure(stderr: str) -> Tuple[str, str, str]:
    """Map yt-dlp's stderr to (reason, user-facing message, detail)."""
    text = (stderr or "").lower()
    detail = _error_line(stderr) if text else ""
    reason = "unknown"
    for needle, code in _ERROR_HINTS:
        if needle in text:
            reason = code
            break
    message = {
        "needs_login": "这条内容需要登录才能看。",
        "not_found": "作品不存在、已删除，或者仅作者本人可见。",
        "unsupported_url": "这个链接不是可下载的视频页。",
        "quality": "这个清晰度拿不到（可能需要登录或大会员）。",
        "network": "网络连接中断（平台 CDN 超时），再试一次。",
        "dep": ("缺少 ffmpeg，B 站这类音视频分开的视频无法合并。"
                "重装最新版工作台即可；或执行 pip install imageio-ffmpeg。"),
        "unknown": "下载失败。",
    }.get(reason, "下载失败。")
    return reason, message, detail or "（yt-dlp 没有输出就退出了）"


def _error_line(stderr: str) -> str:
    """The most informative line: an ERROR that says something, else the tail."""
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if "ERROR" in line and line.replace("ERROR:", "").strip():
            return line[:400]
    meaningful = [line for line in lines if not line.startswith("ERROR:") and "VDL|" not in line]
    if meaningful:
        return meaningful[-1][:400]
    return (stderr or "").strip()[-400:] or "（yt-dlp 没有输出就退出了）"


def _largest_file(directory: str) -> Optional[str]:
    best, best_size = None, -1
    for name in os.listdir(directory) if os.path.isdir(directory) else []:
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        size = os.path.getsize(path)
        if size > best_size:
            best, best_size = path, size
    return best


def _unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    for i in range(2, 100):
        candidate = f"{stem} ({i}){ext}"
        if not os.path.exists(candidate):
            return candidate
    return f"{stem} ({uuid.uuid4().hex[:6]}){ext}"
