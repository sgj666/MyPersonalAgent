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
from typing import Dict, List, Optional

from agent.media.video.platforms import UA
from common.log import logger

BROWSER_TIMEOUT = 90
PAGE_BUDGET_MS = 15000

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


def extract(page_url: str, timeout: int = BROWSER_TIMEOUT) -> Dict:
    """Return {url, title} for one Douyin video page."""
    browser = browser_path()
    if not browser:
        raise DouyinError(
            "no_browser",
            "抖音链接需要本机装有 Chrome 或 Edge 才能解析；也可以导入一次账号 cookies 走 yt-dlp。",
        )

    profile = tempfile.mkdtemp(prefix="cow-douyin-")
    try:
        dom = _dump_dom(browser, page_url, profile, timeout)
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    source = _video_source(dom)
    if not source:
        if "验证" in dom or "login" in dom.lower():
            raise DouyinError("needs_login", "抖音要求验证身份，这条暂时拿不到。", dom[:200])
        raise DouyinError("not_found", "抖音页面没有给出可播放的视频流。", dom[:200])

    return {"url": source, "title": _title(dom)}


def _dump_dom(browser: str, url: str, profile: str, timeout: int) -> str:
    args = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--mute-audio",
        "--hide-scrollbars",
        f"--user-data-dir={profile}",
        f"--virtual-time-budget={PAGE_BUDGET_MS}",
        "--dump-dom",
        "--lang=zh-CN",
        f"--user-agent={UA}",
        url,
    ]
    try:
        result = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            errors="replace",
            text=True,
        )
    except subprocess.TimeoutExpired:
        raise DouyinError("timeout", "抖音页面加载超时。") from None
    except OSError as e:
        raise DouyinError("no_browser", f"启动浏览器失败：{e}") from e

    dom = result.stdout or ""
    if not dom.strip():
        logger.debug(f"[video] douyin dump empty, stderr={result.stderr[:300]}")
        raise DouyinError("not_found", "抖音页面没有返回内容。", (result.stderr or "")[:200])
    return dom


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


def _title(dom: str) -> str:
    match = _TITLE_RE.search(dom)
    if not match:
        return ""
    return _TITLE_SUFFIX_RE.sub("", html.unescape(match.group(1))).strip()
