"""Douyin, through a real browser.

Douyin is the one platform that cannot be read over plain HTTP any more. The
share page that used to embed `_ROUTER_DATA` now answers a script challenge, and
`/aweme/v1/web/aweme/detail/` refuses requests that carry nothing but guest
cookies:

    403 Blocked by ArgusSecurityPlugin Uifid Not Found

That check is answered by JavaScript running in a browser, so this module runs
one: the system Chrome (or Edge) in headless mode, dumped to DOM after the page
settles, and the `<video><source>` the player filled in is the watermark-free
stream. Nothing is installed, no cookies are read from the user's profile and no
account is involved — a throwaway profile is created per call and deleted.

Cost: several seconds per link, and a browser on the machine. That is the price
of not shipping a signature implementation that would break every few weeks.
"""

from __future__ import annotations

import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from typing import Dict, List, Optional

from agent.media.video.platforms import UA
from common.log import logger

# Wall-clock budget for one attempt: browser start plus the player filling in a
# source. The old model gave Chrome a 15s *virtual-time* budget and dumped the
# DOM once; on a slower machine (or when the page never goes idle) that ended as
# "抖音页面加载超时" with nothing to retry against.
BROWSER_START_TIMEOUT = 30
PAGE_POLL_SECONDS = 25
POLL_INTERVAL = 0.4
EXTRACT_ATTEMPTS = 2

# Video CDNs Douyin serves from. A URL outside this list is not handed to the
# downloader, whatever the page says.
CDN_HOSTS = (
    "douyinvod.com",
    "douyin.com",
    "byteicdn.com",
    "byteimg.com",
    "bytedance.com",
    "amemv.com",
    "snssdk.com",
    "ixigua.com",
)

_SOURCE_RE = re.compile(r"<video[^>]*>(.*?)</video>", re.S | re.I)
_SRC_ATTR_RE = re.compile(r"""src=["']([^"']+)["']""", re.I)
_PLAY_ADDR_RE = re.compile(r'"(?:play_addr|playAddr)"\s*:\s*\{[^{}]*"url_list"\s*:\s*\[\s*"([^"]+)"', re.S)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
_TITLE_SUFFIX_RE = re.compile(r"\s*[-–|]\s*抖音\s*$")


class DouyinError(RuntimeError):
    def __init__(self, reason: str, message: str, detail: str = ""):
        super().__init__(message)
        self.reason = reason
        self.detail = detail


def browser_path() -> Optional[str]:
    """The browser to drive: system Chrome first, then Edge, then Chromium."""
    candidates: List[str] = []
    if sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    elif sys.platform.startswith("win"):
        roots = (
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
            os.environ.get("LOCALAPPDATA"),
        )
        for base in roots:
            if not base:
                continue
            candidates += [
                os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
            ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def is_available() -> bool:
    return browser_path() is not None


def extract(page_url: str, timeout: int = PAGE_POLL_SECONDS) -> Dict:
    """Return {url, title} for one Douyin video page.

    Two attempts, because the failure this replaces was a single slow page load.
    A timeout is retried; a missing browser or a login wall is not.
    """
    browser = browser_path()
    if not browser:
        raise DouyinError(
            "no_browser",
            "抖音链接需要本机装有 Chrome 或 Edge 才能解析；也可以导入一次账号 cookies 走 yt-dlp。",
        )

    last: Optional[DouyinError] = None
    for attempt in range(1, EXTRACT_ATTEMPTS + 1):
        try:
            return _extract_once(browser, page_url, timeout)
        except DouyinError as e:
            last = e
            if e.reason != "timeout" or attempt == EXTRACT_ATTEMPTS:
                raise
            logger.info(f"[video] douyin attempt {attempt} timed out, retrying once")
    raise last or DouyinError("timeout", "抖音页面加载超时，点重试。")


def _extract_once(browser: str, page_url: str, timeout: int) -> Dict:
    """Drive one headless window and poll for the stream the player fills in."""
    profile = tempfile.mkdtemp(prefix="cow-douyin-")
    process = None
    try:
        process = subprocess.Popen(
            _browser_args(browser, page_url, profile),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        port = _wait_for_port(profile, BROWSER_START_TIMEOUT)
        if not port:
            raise DouyinError("timeout", "抖音页面加载超时：浏览器没有就绪，点重试。")

        ws = _connect_page(port)
        if ws is None:
            raise DouyinError("timeout", "抖音页面加载超时：拿不到浏览器页面，点重试。")
        try:
            started = time.time()
            deadline = started + timeout
            while time.time() < deadline:
                source = _eval(ws, "(() => { const s = document.querySelector('video source') || document.querySelector('video');"
                                   " const u = s && (s.src || s.currentSrc);"
                                   " return typeof u === 'string' && u.startsWith('http') ? u : ''; })()")
                if source and _cdn_allowed(source):
                    title = _eval(ws, "document.title") or ""
                    return {"url": source, "title": _clean_title(str(title))}
                # Only a *persistent* login/verify wall counts: the page shows
                # "验证" text while its challenge script runs, and bailing on the
                # first poll turned a normal 3s load into a false failure.
                if time.time() > started + 8:
                    body = str(_eval(ws, "document.body ? document.body.innerText.slice(0, 200) : ''") or "")
                    if any(mark in body for mark in ("扫码登录", "请完成验证", "登录后查看", "验证身份")):
                        raise DouyinError("needs_login", "抖音要求验证身份，这条暂时拿不到。", body[:200])
                time.sleep(POLL_INTERVAL)
            raise DouyinError("timeout", "抖音页面加载超时（播放器没有给出视频流），点重试。")
        finally:
            try:
                ws.close()
            except Exception:
                pass
    finally:
        _stop(process)
        shutil.rmtree(profile, ignore_errors=True)


def _browser_args(browser: str, url: str, profile: str) -> List[str]:
    return [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-dev-shm-usage",          # small /dev/shm on Linux and WSL
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--mute-audio",
        "--hide-scrollbars",
        "--remote-debugging-port=0",        # the port lands in DevToolsActivePort
        f"--user-data-dir={profile}",
        "--lang=zh-CN",
        f"--user-agent={UA}",
        url,
    ]


def _wait_for_port(profile: str, timeout: float) -> Optional[int]:
    """Chrome publishes its debugging port in `DevToolsActivePort`."""
    path = os.path.join(profile, "DevToolsActivePort")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                first = handle.readline().strip()
            if first.isdigit():
                return int(first)
        except OSError:
            pass
        time.sleep(0.2)
    return None


def _connect_page(port: int):
    """Attach to the first page target of a debugging port."""
    import json

    import websocket

    for _ in range(20):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as resp:
                targets = json.loads(resp.read().decode("utf-8", "replace"))
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return websocket.create_connection(
                        target["webSocketDebuggerUrl"], timeout=10, suppress_origin=True
                    )
        except Exception as e:
            logger.debug(f"[video] douyin cdp not ready: {e}")
        time.sleep(0.3)
    return None


def _eval(ws, expression: str):
    """Run one expression in the page; None when it fails."""
    import json

    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": expression, "returnByValue": True}}))
        deadline = time.time() + 10
        while time.time() < deadline:
            message = json.loads(ws.recv())
            if message.get("id") == 1:
                return (message.get("result") or {}).get("result", {}).get("value")
    except Exception as e:
        logger.debug(f"[video] douyin evaluate failed: {e}")
    return None


def _stop(process) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=8)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def _video_source(dom: str) -> Optional[str]:
    for block in _SOURCE_RE.findall(dom):
        for src in _SRC_ATTR_RE.findall(block):
            candidate = html.unescape(src).strip()
            if candidate.startswith("blob:"):
                continue
            if _cdn_allowed(candidate):
                return candidate
    match = _PLAY_ADDR_RE.search(dom)
    if match:
        candidate = html.unescape(match.group(1)).replace("\\u002F", "/").replace("\\/", "/")
        if _cdn_allowed(candidate):
            return candidate
    return None


def _cdn_allowed(url: str) -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    return any(host == h or host.endswith("." + h) for h in CDN_HOSTS)


def _clean_title(title: str) -> str:
    return _TITLE_SUFFIX_RE.sub("", html.unescape(title or "")).strip()


def _title(dom: str) -> str:
    match = _TITLE_RE.search(dom)
    if not match:
        return ""
    return _TITLE_SUFFIX_RE.sub("", html.unescape(match.group(1))).strip()
