"""Turn whatever the user pasted into one canonical link per platform.

People paste share text, not links:

    8.88 复制打开抖音，看看【某某的作品】…… https://v.douyin.com/iRxxxx/ 复制此链接…
    在月球建座基地｜九上英语 … https://xhslink.cn/o/7pn3092utJ7 内容复制后，前往【小红书】…

So the input has to be mined for a URL first, and three of the hosts are short
links that yield no video id until the redirect is followed. Both steps live
here, and both are the only place that decides which hosts we are willing to
talk to: nothing downstream sees a URL that did not pass through `normalize()`.

The short-link hop is followed here rather than in the downloader because it
must be checked hop by hop (a short link to a public host can redirect into a
private one), and because the redirect target is what carries Xiaohongshu's
`xsec_token`, without which the note page returns a login wall.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import parse_qs, urlparse

DOUYIN = "douyin"
XHS = "xiaohongshu"
BILIBILI = "bilibili"

PLATFORM_LABELS = {DOUYIN: "抖音", XHS: "小红书", BILIBILI: "B 站"}

# The hosts each platform's pages live on. A link is only ever handed to the
# downloader after its host has been matched here.
PLATFORM_HOSTS = {
    DOUYIN: ("douyin.com", "iesdouyin.com"),
    XHS: ("xiaohongshu.com",),
    BILIBILI: ("bilibili.com", "bilibili.tv"),
}

# Hosts that only redirect. They are resolved here and never downloaded from.
SHORT_HOSTS = ("v.douyin.com", "xhslink.com", "xhslink.cn", "b23.tv")

ALLOWED_HOSTS = tuple(
    host for hosts in PLATFORM_HOSTS.values() for host in hosts
) + SHORT_HOSTS

MAX_REDIRECTS = 5

# A pasted blob ends a URL with punctuation far more often than with a space:
# the share text continues with 「，复制本条信息」 or an emoji.
_URL_RE = re.compile(r"https?://[^\s\u3000，。；！？、（）【】「」《》\"'<>]+", re.IGNORECASE)
_URL_TAIL = ".,;:!?)]}>'\"、，。"

_DOUYIN_ID_RE = re.compile(r"/(?:share/)?video/(\d{6,})")
_XHS_ID_RE = re.compile(r"/(?:explore|discovery/item|item)/([0-9a-fA-F]{24})")
_BILI_BV_RE = re.compile(r"/(BV[0-9A-Za-z]{10})")
_BILI_AV_RE = re.compile(r"/av(\d+)")


class VideoUrlError(ValueError):
    """A pasted blob that names no downloadable video.

    ``reason`` is the contract the UI branches on, so the message can stay a
    sentence for the model to relay.
    """

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class Link:
    platform: str
    url: str
    video_id: str

    @property
    def label(self) -> str:
        return PLATFORM_LABELS.get(self.platform, self.platform)


def host_allowed(hostname: str, hosts=ALLOWED_HOSTS) -> bool:
    host = (hostname or "").strip().lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in hosts)


def find_url(text: str) -> Optional[str]:
    """The first http(s) URL in a pasted blob, without trailing punctuation."""
    for match in _URL_RE.finditer(text or ""):
        candidate = match.group(0).rstrip(_URL_TAIL)
        if len(candidate) > len("https://"):
            return candidate
    return None


def normalize(text: str, opener: Optional[Callable[[str], str]] = None) -> Link:
    """Resolve a pasted blob to the canonical URL of one video.

    ``opener`` is injected in tests: it takes a URL and returns the URL it
    redirects to, or "" when there is no redirect.
    """
    raw = (text or "").strip()
    if not raw:
        raise VideoUrlError("no_link", "没有看到链接：把抖音/小红书/B站的链接或整段分享文案贴进来。")

    url = raw if raw.lower().startswith(("http://", "https://")) else find_url(raw)
    if not url:
        raise VideoUrlError("no_link", "这段文字里没有链接。")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise VideoUrlError("unsupported", f"这不是一个网页链接：{url[:60]}")
    if not host_allowed(parsed.hostname):
        raise VideoUrlError(
            "unsupported",
            f"只支持抖音、小红书和 B 站，这个链接来自 {parsed.hostname}。",
        )

    if host_allowed(parsed.hostname, SHORT_HOSTS):
        direct = _from_short_host(parsed)
        if direct is not None:
            return direct
        url = _follow_short(url, opener or _http_redirect)
        parsed = urlparse(url)
        if not host_allowed(parsed.hostname):
            raise VideoUrlError("unsupported", f"短链跳到了不支持的位置：{parsed.hostname}")

    platform = _platform_of(parsed.hostname)
    canonical = _canonical(platform, parsed)
    if canonical is None:
        raise VideoUrlError(
            "not_video",
            {
                DOUYIN: "这个抖音链接不是视频（可能是直播或用户主页）。",
                XHS: "这个小红书链接不是视频笔记（图文笔记暂不支持）。",
                BILIBILI: "这个 B 站链接不是单个视频（可能是专栏、番剧或用户空间）。",
            }[platform],
        )
    return canonical


def _from_short_host(parsed) -> Optional[Link]:
    """A short host that already names the id needs no network hop.

    `b23.tv/BV1xx411c7mD` is a link, not a redirect; requiring a round trip
    would make the whole feature fail offline for no reason.
    """
    if not host_allowed(parsed.hostname, ("b23.tv",)):
        return None
    return _canonical(BILIBILI, parsed)


def _platform_of(hostname: str) -> str:
    host = (hostname or "").lower()
    for platform, hosts in PLATFORM_HOSTS.items():
        if host_allowed(host, hosts):
            return platform
    raise VideoUrlError("unsupported", f"不认识的站点：{hostname}")


def _follow_short(url: str, opener: Callable[[str], str]) -> str:
    """Follow redirects one hop at a time, refusing to leave the allowlist."""
    for _ in range(MAX_REDIRECTS + 1):
        target = opener(url)
        if not target:
            return url
        parsed = urlparse(target)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise VideoUrlError("unsupported", "短链指向了非法地址。")
        if not host_allowed(parsed.hostname):
            raise VideoUrlError("unsupported", f"短链跳到了不支持的位置：{parsed.hostname}")
        url = target
        if not host_allowed(parsed.hostname, SHORT_HOSTS):
            return url
    raise VideoUrlError("unsupported", "短链跳转次数过多。")


def _http_redirect(url: str) -> str:
    """One redirect hop, without downloading the body."""
    import requests

    from common.log import logger

    try:
        response = requests.get(
            url,
            headers={"User-Agent": UA},
            timeout=(5, 15),
            allow_redirects=False,
            stream=True,
        )
        response.close()
    except Exception as e:
        logger.debug(f"[video] short link {url} failed: {e}")
        raise VideoUrlError("network", "短链解析失败，检查网络后重试。") from e
    if 300 <= response.status_code < 400:
        return response.headers.get("Location") or ""
    return ""


UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


_PARAM_RE_CACHE: dict = {}


def _raw_param(query: str, name: str) -> str:
    """One query parameter exactly as it was written (no percent-decoding).

    `xsec_token` is a signature over the note id: re-encoding it can change a
    `%3D` into `=` and get the page refused, so the raw text is preserved.
    """
    import re

    match = re.search(r"(?:^|&)" + re.escape(name) + r"=([^&]*)", query or "")
    return match.group(1) if match else ""


def _canonical(platform: str, parsed) -> Optional[Link]:
    path = parsed.path or ""
    raw_query = parsed.query or ""
    query = parse_qs(raw_query)

    if platform == DOUYIN:
        match = _DOUYIN_ID_RE.search(path)
        video_id = match.group(1) if match else (query.get("modal_id") or [""])[0]
        if not video_id.isdigit():
            return None
        return Link(DOUYIN, f"https://www.douyin.com/video/{video_id}", video_id)

    if platform == XHS:
        match = _XHS_ID_RE.search(path)
        if not match:
            return None
        note_id = match.group(1).lower()
        url = f"https://www.xiaohongshu.com/discovery/item/{note_id}"
        token = _raw_param(raw_query, "xsec_token")
        if token:
            url += f"?xsec_token={token}"
        return Link(XHS, url, note_id)

    match = _BILI_BV_RE.search(path)
    if match:
        video_id = match.group(1)
    else:
        match = _BILI_AV_RE.search(path)
        if not match:
            return None
        video_id = "av" + match.group(1)
    url = f"https://www.bilibili.com/video/{video_id}/"
    page = (query.get("p") or [""])[0]
    if page.isdigit() and page != "1":
        url += f"?p={page}"
    return Link(BILIBILI, url, video_id)
