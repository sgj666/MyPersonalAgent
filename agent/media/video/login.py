"""Take a session from the human, without ever seeing their password.

Two mechanisms, picked per platform by what the platform actually offers:

- **Bilibili, official QR login.** Generate a QR from the passport API, poll it
  until the phone confirms, and the returned cookies go straight into
  `cookies.txt`. No browser, no page scraping, ~90 seconds of the user's time.
- **Xiaohongshu / Douyin, a browser window they log into.** Those two have no
  public QR endpoint, so the honest path is: open a real window on the login
  page, let them scan, then read the cookies out of that throwaway profile over
  the DevTools protocol. Reading cookies this way avoids touching Chrome's
  cookie database (and therefore the OS keychain).

Both end in `credentials.save()`, so the rest of the system only ever deals with
"cookies exist" or "they do not".
"""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import threading
import time
from typing import Dict, Optional
from urllib.parse import parse_qs, urlparse

from agent.media.video import credentials, douyin, platforms
from common.log import logger

BILI_QR_GENERATE = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
BILI_QR_POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

# Bilibili's own codes for the poll endpoint.
BILI_STATE = {
    0: "ok",
    86101: "waiting",
    86090: "scanned",
    86038: "expired",
}

LOGIN_PAGES = {
    "xiaohongshu": "https://www.xiaohongshu.com/",
    "douyin": "https://www.douyin.com/",
}

BROWSER_START_TIMEOUT = 25
BROWSER_LOGIN_TIMEOUT = 300

_browsers: Dict[str, subprocess.Popen] = {}
_lock = threading.Lock()


class LoginError(RuntimeError):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


# ---------------------------------------------------------------------------
# Shared
# ---------------------------------------------------------------------------

def qr_png(text: str) -> str:
    """A QR code as a data URL, so the page needs no image endpoint."""
    import qrcode

    image = qrcode.make(text)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def status() -> Dict[str, Dict]:
    """Per-platform login state plus whether the platform supports QR here."""
    state = credentials.status()
    for platform, info in state.items():
        info["method"] = "qr" if platform == "bilibili" else "browser"
        info["label"] = platforms.PLATFORM_LABELS.get(platform, platform)
    return state


# ---------------------------------------------------------------------------
# Bilibili: official QR login
# ---------------------------------------------------------------------------

def bili_start() -> Dict:
    import requests

    try:
        response = requests.get(
            BILI_QR_GENERATE,
            headers={"User-Agent": platforms.UA, "Referer": "https://www.bilibili.com/"},
            timeout=15,
        )
        payload = response.json()
    except Exception as e:
        raise LoginError("network", "连不上 B 站登录服务，检查网络后重试。") from e

    if payload.get("code") != 0 or not (payload.get("data") or {}).get("qrcode_key"):
        raise LoginError("unknown", f"B 站没有生成二维码（code={payload.get('code')}）。")

    data = payload["data"]
    return {"platform": "bilibili", "method": "qr", "key": data["qrcode_key"],
            "qr": qr_png(data["url"]), "expires_in": 180}


def bili_poll(key: str) -> Dict:
    """Poll one QR. On success the cookies are already written."""
    import requests

    if not key:
        raise LoginError("bad_request", "缺少二维码 key。")
    try:
        response = requests.get(
            BILI_QR_POLL,
            params={"qrcode_key": key},
            headers={"User-Agent": platforms.UA, "Referer": "https://www.bilibili.com/"},
            timeout=15,
        )
        payload = response.json()
    except Exception as e:
        raise LoginError("network", "查询登录状态失败。") from e

    data = payload.get("data") or {}
    state = BILI_STATE.get(data.get("code"), "waiting")
    if state != "ok":
        return {"state": state, "saved": 0, "message": data.get("message") or ""}

    cookies = _bili_cookies(response, data)
    saved = credentials.save("bilibili", cookies)
    if not saved:
        raise LoginError("unknown", "B 站说登录成功，但没有拿到 cookie。")
    return {"state": "ok", "saved": saved}


def _bili_cookies(response, data: Dict) -> list:
    """Cookies arrive twice; take whichever the endpoint filled in.

    The poll answers with `Set-Cookie` headers, and repeats the same values in
    `data.url` for older clients. Relying on one of them means a silently empty
    login when the other changes.
    """
    found = []
    try:
        for cookie in response.cookies:
            found.append({
                "domain": cookie.domain or ".bilibili.com",
                "name": cookie.name,
                "value": cookie.value,
                "path": cookie.path or "/",
                "secure": bool(cookie.secure),
                "expires": cookie.expires,
            })
    except Exception as e:  # pragma: no cover - requests internals
        logger.debug(f"[video] bilibili set-cookie parse failed: {e}")

    target = data.get("url") or ""
    if target:
        query = parse_qs(urlparse(target).query)
        for name in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
            value = (query.get(name) or [""])[0]
            if value and not any(c["name"] == name for c in found):
                found.append({
                    "domain": ".bilibili.com", "name": name, "value": value,
                    "path": "/", "secure": True, "expires": None,
                })
    return found


# ---------------------------------------------------------------------------
# Xiaohongshu / Douyin: a window the user logs into
# ---------------------------------------------------------------------------

def browser_start(platform: str, visible: bool = True) -> Dict:
    """Open the platform's login page in a dedicated profile.

    The profile lives under the state root and is reused between attempts, so a
    user who logs in once does not have to scan again on the next `start`.
    """
    if platform not in LOGIN_PAGES:
        raise LoginError("bad_request", f"{platform} 不支持浏览器登录。")

    with _lock:
        running = _browsers.get(platform)
        if running is not None and running.poll() is None:
            return {"platform": platform, "method": "browser", "already_open": True}

        browser = douyin.browser_path()
        if not browser:
            raise LoginError("no_browser", "本机没有 Chrome 或 Edge，装一个再试。")

        profile = _profile_dir(platform)
        args = [
            browser,
            f"--user-data-dir={profile}",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate",
            "--window-size=520,760",
            LOGIN_PAGES[platform],
        ]
        if not visible:
            args.insert(1, "--headless=new")
        try:
            process = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        except OSError as e:
            raise LoginError("no_browser", f"启动浏览器失败：{e}") from e

        _browsers[platform] = process
        if not _wait_for_port(profile):
            _stop(platform)
            raise LoginError("no_browser", "浏览器启动了但没有就绪，重试一次。")
        return {"platform": platform, "method": "browser", "already_open": False}


def browser_poll(platform: str) -> Dict:
    """Read the profile's cookies; if a session is there, import and close up."""
    if platform not in LOGIN_PAGES:
        raise LoginError("bad_request", f"{platform} 不支持浏览器登录。")

    profile = _profile_dir(platform)
    port = _port_of(profile)
    if not port:
        raise LoginError("not_started", "登录窗口没有打开，先点「去登录」。")

    cookies = _cdp_cookies(port)
    session = credentials.SESSION_COOKIES[platform]
    if not any(c.get("name") in session and c.get("value") for c in cookies):
        return {"state": "waiting", "saved": 0}

    saved = credentials.save(platform, cookies)
    _stop(platform)
    return {"state": "ok", "saved": saved}


def browser_close(platform: str) -> Dict:
    _stop(platform)
    return {"state": "closed"}


def _profile_dir(platform: str) -> str:
    from common.state_dir import state_path

    path = str(state_path("browser-profile", platform))
    os.makedirs(path, exist_ok=True)
    return path


def _port_of(profile: str) -> Optional[int]:
    """Chrome publishes its debugging port in `DevToolsActivePort`."""
    path = os.path.join(profile, "DevToolsActivePort")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            first = handle.readline().strip()
        return int(first) if first.isdigit() else None
    except (OSError, ValueError):
        return None


def _wait_for_port(profile: str, timeout: float = BROWSER_START_TIMEOUT) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _port_of(profile):
            return True
        time.sleep(0.3)
    return False


def _cdp_cookies(port: int) -> list:
    """Every cookie in the profile, over the DevTools protocol."""
    import websocket

    path = "/devtools/browser"
    try:
        info = json.loads(_http_get(f"http://127.0.0.1:{port}/json/version"))
        ws_url = info.get("webSocketDebuggerUrl") or f"ws://127.0.0.1:{port}{path}"
    except Exception as e:
        logger.debug(f"[video] cdp version lookup failed: {e}")
        ws_url = f"ws://127.0.0.1:{port}{path}"

    try:
        connection = websocket.create_connection(ws_url, timeout=10)
    except Exception as e:
        raise LoginError("browser", "连不上登录窗口，关掉重开一次。") from e

    try:
        connection.send(json.dumps({"id": 1, "method": "Storage.getCookies", "params": {}}))
        deadline = time.time() + 10
        while time.time() < deadline:
            message = json.loads(connection.recv())
            if message.get("id") != 1:
                continue
            cookies = (message.get("result") or {}).get("cookies") or []
            return [
                {
                    "domain": c.get("domain") or "",
                    "name": c.get("name") or "",
                    "value": c.get("value") or "",
                    "path": c.get("path") or "/",
                    "secure": bool(c.get("secure")),
                    "expires": c.get("expires"),
                }
                for c in cookies
            ]
        return []
    except Exception as e:
        raise LoginError("browser", "读取登录信息失败。") from e
    finally:
        try:
            connection.close()
        except Exception:
            pass


def _http_get(url: str) -> str:
    import urllib.request

    with urllib.request.urlopen(url, timeout=5) as response:  # noqa: S310 - loopback only
        return response.read().decode("utf-8", "replace")


def _stop(platform: str) -> None:
    with _lock:
        process = _browsers.pop(platform, None)
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
