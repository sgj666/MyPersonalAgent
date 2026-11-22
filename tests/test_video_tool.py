"""video_download tool: the model-facing shell around service.download."""

import json

from agent.media.video import service
from agent.tools.video_download.video_download import VideoDownloadTool


def test_schema_shape():
    tool = VideoDownloadTool()
    assert tool.name == "video_download"
    params = tool.params
    assert params["required"] == ["url"]
    assert set(params["properties"]) == {"url", "quality", "max_mb"}
    assert "best" in params["properties"]["quality"]["enum"]


def test_empty_url_is_refused_without_touching_the_network():
    result = VideoDownloadTool().execute({"url": "   "})
    assert result.status == "error"
    assert "url" in str(result.result)


def test_missing_link_in_the_share_text_is_reported_as_advice():
    result = VideoDownloadTool().execute({"url": "帮我下载一下这个视频"})
    assert result.status == "error"
    assert "no_link" in str(result.result)


def test_success_carries_the_path_the_artifact_index_needs(monkeypatch, tmp_path):
    target = tmp_path / "a.mp4"
    target.write_bytes(b"x")

    def fake_download(url, quality="best", max_mb=None, on_event=None):
        if on_event:
            on_event({"stage": "download", "percent": 50.0, "speed": "1.0 MB/s"})
        return {"path": str(target), "title": "示例", "size": 1, "platform": "douyin", "url": url}

    monkeypatch.setattr(service, "download", fake_download)
    result = VideoDownloadTool().execute({"url": "https://v.douyin.com/x/"})

    assert result.status == "success"
    payload = json.loads(result.result)
    assert payload["path"] == str(target)
    assert payload["title"] == "示例"
    assert result.display == "已保存：示例"


def test_tool_failure_exposes_the_reason(monkeypatch):
    def boom(*args, **kwargs):
        raise service.VideoError("needs_login", "这条内容需要登录才能看。")

    monkeypatch.setattr(service, "download", boom)
    result = VideoDownloadTool().execute({"url": "https://v.douyin.com/x/"})
    assert result.status == "error"
    assert "needs_login" in str(result.result)


def test_availability_follows_ytdlp(monkeypatch):
    monkeypatch.setattr(service, "available", lambda: False)
    assert VideoDownloadTool().is_available() is False
    monkeypatch.setattr(service, "available", lambda: True)
    assert VideoDownloadTool().is_available() is True
