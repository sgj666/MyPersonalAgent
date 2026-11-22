"""The video view's HTTP surface: status / probe / download(SSE) / recent / delete / login."""

import json
from unittest.mock import patch

import pytest

from channel.web.api import video as video_api


class _Input(dict):
    """web.input() storage: attribute access and .get() both work."""

    __getattr__ = dict.__getitem__


def _call(handler_cls, method, params=None, body=None, **patches):
    params = params or {}
    with patch.object(video_api, "_require_auth"), \
         patch.object(video_api.web, "header"), \
         patch.object(video_api.web, "input", return_value=_Input(params)), \
         patch.object(video_api.web, "data", return_value=json.dumps(body or {}).encode("utf-8")):
        return getattr(handler_cls(), method)()


def _json_of(payload):
    return json.loads(payload) if isinstance(payload, str) else payload


def _sse(payload):
    frames = []
    for chunk in payload:
        text = chunk.decode("utf-8")
        for line in text.splitlines():
            if line.startswith("data: "):
                frames.append(json.loads(line[len("data: "):]))
    return frames


def test_status_reports_engine_and_accounts():
    fake = {"ytdlp": True, "version": "2026.10.21", "ffmpeg": "/ff", "browser": "/chrome",
            "platforms": ["抖音"], "accounts": {"bilibili": {"logged_in": False}}}
    with patch.object(video_api.service, "status", return_value=fake):
        payload = _json_of(_call(video_api.VideoStatusHandler, "GET"))
    assert payload["status"] == "success"
    assert payload["version"] == "2026.10.21"
    assert payload["accounts"]["bilibili"]["logged_in"] is False


def test_probe_requires_a_url():
    payload = _json_of(_call(video_api.VideoProbeHandler, "GET"))
    assert payload["code"] == "bad_request"


def test_probe_returns_metadata():
    info = {"platform": "xiaohongshu", "title": "示例", "size": 10}
    with patch.object(video_api.service, "probe", return_value=info):
        payload = _json_of(_call(video_api.VideoProbeHandler, "GET", {"url": "https://xhslink.cn/o/x"}))
    assert payload["status"] == "success"
    assert payload["title"] == "示例"


def test_probe_maps_a_refusal_to_its_reason():
    def boom(text):
        raise video_api.service.VideoError("not_video", "这不是视频。")

    with patch.object(video_api.service, "probe", boom):
        payload = _json_of(_call(video_api.VideoProbeHandler, "GET", {"url": "https://x/y"}))
    assert payload["status"] == "error"
    assert payload["code"] == "not_video"


def test_download_streams_progress_and_the_final_path(tmp_path):
    target = tmp_path / "a.mp4"
    target.write_bytes(b"x")

    def fake_download(url, quality="best", max_mb=None, source=None, title=None, on_event=None):
        on_event({"stage": "probe"})
        on_event({"stage": "download", "percent": 50.0})
        return {"path": str(target), "title": "示例", "size": 1, "platform": "douyin"}

    with patch.object(video_api.service, "download", fake_download):
        frames = _sse(_call(video_api.VideoDownloadHandler, "GET", {"url": "https://v.douyin.com/x/"}))
    assert [f["stage"] for f in frames] == ["probe", "download", "done"]
    assert frames[-1]["path"] == str(target)


def test_download_reports_a_refusal_as_a_frame_not_a_500():
    def boom(*args, **kwargs):
        raise video_api.service.VideoError("needs_login", "需要登录。")

    with patch.object(video_api.service, "download", boom):
        frames = _sse(_call(video_api.VideoDownloadHandler, "GET", {"url": "https://v.douyin.com/x/"}))
    assert frames[-1]["stage"] == "error"
    assert frames[-1]["reason"] == "needs_login"


def test_recent_lists_videos_newest_first(tmp_path):
    root = tmp_path / "视频下载" / "2026-11-22"
    root.mkdir(parents=True)
    old = root / "old.mp4"
    new = root / "new.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"y")
    (root / "notes.txt").write_text("x", encoding="utf-8")
    import os
    import time

    os.utime(old, (time.time() - 100, time.time() - 100))

    with patch("common.state_dir.output_dir", return_value=tmp_path):
        payload = _json_of(_call(video_api.VideoRecentHandler, "GET"))
    assert [item["name"] for item in payload["items"]] == ["new.mp4", "old.mp4"]


def test_delete_refuses_paths_outside_the_download_tree(tmp_path):
    outside = tmp_path / "secret.mp4"
    outside.write_bytes(b"x")
    with patch("common.state_dir.output_dir", return_value=tmp_path / "output"):
        payload = _json_of(_call(video_api.VideoDeleteHandler, "POST", body={"path": str(outside)}))
    assert payload["status"] == "error"
    assert "只能删除" in payload["message"]
    assert outside.exists()


def test_delete_removes_a_download(tmp_path):
    video_dir = tmp_path / "output" / "视频下载" / "2026-11-22"
    video_dir.mkdir(parents=True)
    video = video_dir / "a.mp4"
    video.write_bytes(b"x")
    with patch("common.state_dir.output_dir", return_value=tmp_path / "output"):
        payload = _json_of(_call(video_api.VideoDeleteHandler, "POST", body={"path": str(video)}))
    assert payload["status"] == "success"
    assert not video.exists()


def test_login_start_routes_bilibili_to_the_qr_flow():
    with patch.object(video_api.service, "login_start", return_value={"method": "qr", "qr": "data:x"}) as start:
        payload = _json_of(_call(video_api.VideoLoginStartHandler, "POST", body={"platform": "bilibili"}))
    assert payload["method"] == "qr"
    start.assert_called_once_with("bilibili")


def test_login_start_refuses_unknown_platforms():
    payload = _json_of(_call(video_api.VideoLoginStartHandler, "POST", body={"platform": "netease"}))
    assert payload["code"] == "bad_request"


def test_login_poll_passes_the_key_through():
    with patch.object(video_api.service, "login_poll", return_value={"state": "waiting"}) as poll:
        payload = _json_of(_call(video_api.VideoLoginPollHandler, "GET",
                                {"platform": "bilibili", "key": "abc"}))
    assert payload["state"] == "waiting"
    poll.assert_called_once_with("bilibili", "abc")


def test_logout_clears_and_returns_the_new_status():
    with patch.object(video_api.service, "logout", return_value=3), \
         patch.object(video_api.service, "status", return_value={"accounts": {}}):
        payload = _json_of(_call(video_api.VideoLogoutHandler, "POST", body={"platform": "bilibili"}))
    assert payload["removed"] == 3


@pytest.mark.parametrize("route", [
    "/api/video/status", "/api/video/probe", "/api/video/download",
    "/api/video/recent", "/api/video/delete",
    "/api/video/login/start", "/api/video/login/poll", "/api/video/login/close",
    "/api/video/logout",
])
def test_routes_are_registered(route):
    from channel.web.web_channel import URLS

    assert route in [URLS[i] for i in range(0, len(URLS), 2)]


def test_cancel_asks_the_service_to_stop():
    with patch.object(video_api.service, "cancel", return_value={"cancelled": True}) as cancel:
        payload = _json_of(_call(video_api.VideoCancelHandler, "POST", body={}))
    assert payload["cancelled"] is True
    cancel.assert_called_once()


@pytest.mark.parametrize("route", ["/api/video/cancel"])
def test_cancel_route_is_registered(route):
    from channel.web.web_channel import URLS

    assert route in [URLS[i] for i in range(0, len(URLS), 2)]


def test_poster_needs_a_path_inside_the_download_tree(tmp_path):
    outside = tmp_path / "secret.mp4"
    outside.write_bytes(b"x")
    with patch("common.state_dir.output_dir", return_value=tmp_path / "output"):
        for params in ({}, {"path": str(outside)}):
            with patch.object(video_api.web, "notfound", side_effect=Exception("404")):
                try:
                    _call(video_api.VideoPosterHandler, "GET", params)
                except Exception as e:
                    assert "404" in str(e)
                else:
                    raise AssertionError("poster accepted a path outside the download tree")


def test_poster_serves_the_cached_jpeg(tmp_path):
    root = tmp_path / "output" / "视频下载" / "2026-11-22"
    root.mkdir(parents=True)
    video = root / "a.mp4"
    video.write_bytes(b"x")
    poster = tmp_path / "poster.jpg"
    poster.write_bytes(b"JPEGDATA")

    with patch("common.state_dir.output_dir", return_value=tmp_path / "output"), \
         patch.object(video_api.service, "poster", return_value=str(poster)):
        body = _call(video_api.VideoPosterHandler, "GET", {"path": str(video)})
    assert body == b"JPEGDATA"


def test_poster_is_not_found_when_ffmpeg_cannot_read_the_file(tmp_path):
    root = tmp_path / "output" / "视频下载" / "2026-11-22"
    root.mkdir(parents=True)
    video = root / "a.mp4"
    video.write_bytes(b"x")
    with patch("common.state_dir.output_dir", return_value=tmp_path / "output"), \
         patch.object(video_api.service, "poster", return_value=None), \
         patch.object(video_api.web, "notfound", side_effect=Exception("404")):
        try:
            _call(video_api.VideoPosterHandler, "GET", {"path": str(video)})
        except Exception as e:
            assert "404" in str(e)
        else:
            raise AssertionError("poster answered without an image")


@pytest.mark.parametrize("name, platform", [
    ("《我救不死你》 [BV1bGysz7EoD].mp4", "bilibili"),
    ("110 诡异冥谷 [6613856].mp4", "bilibili"),
    ("在月球建座基地｜九上英语 [6b0142e8000000001802a072].mp4", "xiaohongshu"),
    ("没文化嘴硬挽尊的我 [7710212552923303202].mp4", "douyin"),
    ("没文化嘴硬挽尊的我 [7710212552923303202] (2).mp4", "douyin"),
    ("没有编号的老文件.mp4", ""),
])
def test_recent_names_are_attributed_to_a_platform(name, platform):
    assert video_api.platform_of_name(name) == platform
