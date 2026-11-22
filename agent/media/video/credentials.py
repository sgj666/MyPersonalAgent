"""Optional account cookies, in the one format yt-dlp already understands.

Nothing here is required to download: Xiaohongshu and Bilibili work as a guest,
and Douyin is read through a browser (see `douyin.py`). This module exists for
the cases where the platform itself says no — a note behind a login wall, a
1080P+ stream that needs membership — so the user can hand over their own
session instead of being told "it cannot be done".

Two rules keep it honest:

- **Opt-in and local.** One `cookies.txt` under the state root, mode 600, never
  logged, never returned to the client beyond "logged in / not logged in".
- **Merge, never clobber.** Each platform owns its own lines in the file, so
  logging into Bilibili does not drop a Xiaohongshu session.
"""

from __future__ import annotations

import os
import time
from typing import Dict, Iterable, List, Optional

from common.log import logger

PLATFORMS = ("bilibili", "xiaohongshu", "douyin")

# The cookie that only exists once a human is actually signed in. Guest cookies
# (`a1`, `ttwid`, `buvid3`) are deliberately not in here: they prove the page was
# visited, not that an account is behind it.
SESSION_COOKIES = {
    "bilibili": ("SESSDATA",),
    "xiaohongshu": ("web_session",),
    "douyin": ("sessionid", "sessionid_ss", "sid_tt"),
}

# The hosts a platform's cookies are valid for, so a cookie captured on one
# domain is written back to the right place.
PLATFORM_HOSTS = {
    "bilibili": (".bilibili.com",),
    "xiaohongshu": (".xiaohongshu.com",),
    "douyin": (".douyin.com",),
}

HEADER = "# Netscape HTTP Cookie File\n"


def cookies_path() -> str:
    from common.state_dir import state_path

    path = str(state_path("credentials", "cookies.txt"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def _chmod(path: str) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def read_lines() -> List[str]:
    path = cookies_path()
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read().splitlines()
    except OSError as e:
        logger.warning(f"[video] cookies unreadable: {e}")
        return []


def parse() -> List[Dict[str, str]]:
    """The file as a list of {domain, name, value, ...}, comments skipped."""
    rows = []
    for line in read_lines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        rows.append({
            "domain": parts[0],
            "include_subdomains": parts[1],
            "path": parts[2],
            "secure": parts[3],
            "expires": parts[4],
            "name": parts[5],
            "value": parts[6],
        })
    return rows


def platform_of(domain: str) -> Optional[str]:
    host = (domain or "").lstrip(".").lower()
    for platform, domains in PLATFORM_HOSTS.items():
        for suffix in domains:
            bare = suffix.lstrip(".")
            if host == bare or host.endswith("." + bare):
                return platform
    return None


def has_session(platform: str) -> bool:
    names = {row["name"] for row in parse() if platform_of(row["domain"]) == platform}
    return any(name in names for name in SESSION_COOKIES.get(platform, ()))


def status() -> Dict[str, Dict[str, object]]:
    """Per-platform login state, for the settings card."""
    present: Dict[str, int] = {p: 0 for p in PLATFORMS}
    names: Dict[str, List[str]] = {p: [] for p in PLATFORMS}
    for row in parse():
        platform = platform_of(row["domain"])
        if not platform:
            continue
        present[platform] += 1
        names[platform].append(row["name"])
    return {
        platform: {
            "logged_in": has_session(platform),
            "cookies": present[platform],
            "session_cookie": next(
                (n for n in SESSION_COOKIES[platform] if n in names[platform]), None
            ),
        }
        for platform in PLATFORMS
    }


def save(platform: str, cookies: Iterable[Dict]) -> int:
    """Merge cookies for one platform into the file. Returns how many were kept.

    A cookie without a name or a value is dropped rather than written: an empty
    `SESSDATA` would read as "logged in" to every downstream check.
    """
    hosts = PLATFORM_HOSTS.get(platform)
    if not hosts:
        raise ValueError(f"unknown platform: {platform}")

    kept: List[Dict] = []
    for cookie in cookies or []:
        name = str(cookie.get("name") or "").strip()
        value = str(cookie.get("value") or "")
        if not name or not value:
            continue
        domain = str(cookie.get("domain") or hosts[0])
        if not any(domain.lstrip(".").endswith(h.lstrip(".")) for h in hosts):
            continue
        kept.append({
            "domain": domain,
            "include_subdomains": "TRUE" if domain.startswith(".") else "FALSE",
            "path": cookie.get("path") or "/",
            "secure": "TRUE" if cookie.get("secure", True) else "FALSE",
            "expires": str(int(cookie.get("expires") or time.time() + 180 * 86400)),
            "name": name,
            "value": value,
        })

    if not kept:
        return 0

    others = [line for line in read_lines() if line.strip() and not line.lstrip().startswith("#")]
    others = [
        line for line in others
        if platform_of(line.split("\t")[0]) not in (platform, None)
    ] if others else []

    body = others + ["\t".join(row[k] for k in (
        "domain", "include_subdomains", "path", "secure", "expires", "name", "value"
    )) for row in kept]

    path = cookies_path()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(HEADER)
        for line in body:
            handle.write(line + "\n")
    _chmod(tmp)
    os.replace(tmp, path)
    _chmod(path)
    logger.info(f"[video] cookies saved for {platform}: {len(kept)}")
    return len(kept)


def clear(platform: Optional[str] = None) -> int:
    """Forget one platform's cookies, or everything. Returns lines removed."""
    lines = read_lines()
    if not lines:
        return 0
    path = cookies_path()
    kept, removed = [], 0
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            kept.append(line)
            continue
        row_platform = platform_of(line.split("\t")[0])
        if platform is None or row_platform == platform:
            removed += 1
            continue
        kept.append(line)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write("\n".join(kept).rstrip("\n") + "\n")
    _chmod(tmp)
    os.replace(tmp, path)
    _chmod(path)
    return removed


def ytdlp_cookie_args() -> List[str]:
    """`--cookies <file>` when a file with anything in it exists."""
    if not any(row["name"] for row in parse()):
        return []
    return ["--cookies", cookies_path()]
