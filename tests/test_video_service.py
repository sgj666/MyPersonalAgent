"""service: the job-level guarantees — refusals before any network work."""

import pytest

from agent.media.video import service


def test_size_is_clamped_to_a_sane_range():
    assert service._clamp_size(0) == 1
    assert service._clamp_size("720") == 720
    assert service._clamp_size(None) == service.DEFAULT_MAX_MB
    assert service._clamp_size(999999) == service.MAX_MB_LIMIT
    assert service._clamp_size("nonsense") == service.DEFAULT_MAX_MB


def test_names_lose_path_separators():
    assert "/" not in service._safe_name("a/b:c*d")
    assert service._safe_name("   ") == "douyin"


def test_duplicate_names_do_not_overwrite(tmp_path):
    first = tmp_path / "a.mp4"
    first.write_bytes(b"x")
    assert service._unique_path(str(first)).endswith("a (2).mp4")


def test_non_video_link_is_refused_before_downloading():
    with pytest.raises(service.VideoError) as err:
        service.download("https://example.com/video/1")
    assert err.value.reason == "unsupported"


def test_a_second_download_is_told_busy_instead_of_queueing(monkeypatch):
    assert service._lock.acquire(blocking=False)
    try:
        with pytest.raises(service.VideoError) as err:
            service.download("https://b23.tv/BV1bGysz7EoD")
        assert err.value.reason == "busy"
    finally:
        service._lock.release()


def test_status_reports_what_the_page_needs(monkeypatch):
    monkeypatch.setattr(service.runner, "version", lambda: "2026.10.21")
    monkeypatch.setattr(service.runner, "find_command", lambda: ["yt-dlp"])
    monkeypatch.setattr(service.runner, "ffmpeg_location", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(service.douyin, "browser_path", lambda: "/chrome")
    status = service.status()
    assert status["ytdlp"] is True
    assert status["version"] == "2026.10.21"
    assert status["browser"] == "/chrome"
    assert "抖音" in status["platforms"]


def test_missing_ytdlp_makes_the_tool_unavailable(monkeypatch):
    monkeypatch.setattr(service.runner, "find_command", lambda: None)
    assert service.available() is False


def test_cancel_is_a_flag_the_download_checks(monkeypatch):
    from agent.media.video import service as svc

    svc._cancel.clear()
    assert svc.cancel()["cancelled"] is True
    assert svc._cancel.is_set()
    svc._cancel.clear()
    assert not svc._cancel.is_set()


# ---------------------------------------------------------------------------
# Engine self-install: open the workbench and it works, no manual pip.
# ---------------------------------------------------------------------------

def test_status_starts_an_install_when_the_engine_is_missing(monkeypatch):
    calls = []
    monkeypatch.delenv("COW_SKIP_AUTO_INSTALL", raising=False)
    monkeypatch.setattr(service.runner, "find_command", lambda: None)
    monkeypatch.setattr(service.runner, "ensure_engine", lambda: calls.append(1) or {"running": True, "error": "", "ready": False})
    monkeypatch.setattr(service.login, "status", lambda: {})
    status = service.status()
    assert status["ytdlp"] is False
    assert status["installing"] is True
    assert calls == [1]


def test_status_is_quiet_when_the_engine_is_there(monkeypatch):
    monkeypatch.setattr(service.runner, "find_command", lambda: ["yt-dlp"])
    monkeypatch.setattr(service.runner, "version", lambda: "2026.10.21")
    monkeypatch.setattr(service.runner, "ffmpeg_location", lambda: "/ff")
    monkeypatch.setattr(service.douyin, "browser_path", lambda: "/chrome")
    monkeypatch.setattr(service.login, "status", lambda: {})
    status = service.status()
    assert status["installing"] is False
    assert status["install_error"] == ""


def test_install_is_not_retried_while_it_runs(monkeypatch):
    from agent.media.video import runner as r

    monkeypatch.delenv("COW_SKIP_AUTO_INSTALL", raising=False)
    monkeypatch.setattr(r, "find_command", lambda: None)
    monkeypatch.setattr(r, "_install_state", {"running": False, "error": "", "started_at": 0.0, "last_try": 0.0})
    started = []
    monkeypatch.setattr(r.threading, "Thread", lambda **kw: type("T", (), {"start": lambda self: started.append(1)})())
    assert r.ensure_engine()["running"] is True
    # Second call while the flag is set must not start another thread.
    r._install_state["running"] = True
    assert r.ensure_engine()["running"] is True
    assert started == [1]


def test_auto_install_can_be_disabled(monkeypatch):
    from agent.media.video import runner as r

    monkeypatch.setenv("COW_SKIP_AUTO_INSTALL", "1")
    monkeypatch.setattr(r, "find_command", lambda: None)
    assert r.ensure_engine()["running"] is False


def test_a_frozen_bundle_never_tries_to_pip_install(monkeypatch):
    """The packaged desktop app has no pip: the engine must be frozen in."""
    import sys

    from agent.media.video import runner as r

    monkeypatch.delenv("COW_SKIP_AUTO_INSTALL", raising=False)
    monkeypatch.setattr(r, "find_command", lambda: None)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    before = dict(r._install_state)
    result = r.ensure_engine()
    assert result["running"] is False
    assert "打包版" in result["error"]
    assert r._install_state == before


def test_poster_is_generated_once_and_reused(tmp_path, monkeypatch):
    """One ffmpeg call per file; the tile then loads a 15KB jpeg, not a frame."""
    import os

    video = tmp_path / "a.mp4"
    video.write_bytes(b"x")
    calls = []

    class Result:
        returncode = 0
        stderr = b""

    def fake_run(command, **kwargs):
        calls.append(command)
        # ffmpeg writes to the last argument
        with open(command[-1], "wb") as handle:
            handle.write(b"JPEG")
        return Result()

    monkeypatch.setattr(service.runner, "ffmpeg_location", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(service.subprocess, "run", fake_run)
    monkeypatch.setattr(service, "_tmp_root", lambda: str(tmp_path / "tmp"))

    first = service.poster(str(video))
    second = service.poster(str(video))

    assert first == second and first and os.path.getsize(first) == 4
    assert len(calls) == 1


def test_poster_is_skipped_without_ffmpeg(tmp_path, monkeypatch):
    video = tmp_path / "a.mp4"
    video.write_bytes(b"x")
    monkeypatch.setattr(service.runner, "ffmpeg_location", lambda: None)
    assert service.poster(str(video)) is None
