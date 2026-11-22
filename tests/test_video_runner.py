"""runner: yt-dlp's output, turned into progress events and actionable reasons."""

import pytest

from agent.media.video import runner


def test_progress_line_becomes_an_event():
    event = runner._parse_progress("VDL| 62.4%|  3.1MiB/s|00:07|31457280|50331648")
    assert event["stage"] == "download"
    assert event["percent"] == 62.4
    assert event["speed"] == "3.1MiB/s"
    assert event["eta"] == "00:07"
    assert event["downloaded"] == 31457280


def test_progress_without_a_percentage_is_computed_from_bytes():
    event = runner._parse_progress("VDL|NA|1.0MiB/s|00:01|500|1000")
    assert event["percent"] == 50.0


def test_unrelated_lines_are_not_progress():
    assert runner._parse_progress("[download] Destination: a.mp4") is None
    assert runner._parse_progress("VDL|garbage") is None


@pytest.mark.parametrize(
    "stderr, reason",
    [
        ("ERROR: [Douyin] 123: Fresh cookies (not necessarily logged in) are needed", "needs_login"),
        ("ERROR: [BiliBili] BV1: This video is private", "not_found"),
        ("ERROR: Unsupported URL: https://example.com", "unsupported_url"),
        ("ERROR: Requested format is not available", "quality"),
        ("[download] Got error: connection timed out", "network"),
        ("ERROR: ffmpeg not found. Please install or provide the path", "dep"),
        ("ERROR: something nobody has seen before", "unknown"),
    ],
)
def test_failures_are_classified(stderr, reason):
    assert runner._failure(stderr)[0] == reason


def test_failure_detail_falls_back_to_the_tail():
    reason, message, detail = runner._failure("ERROR:\n[download] some context")
    assert reason == "unknown"
    assert message
    assert "context" in detail


def test_title_comes_from_its_own_marker_not_the_first_noisy_line():
    """Merging stdout+stderr puts yt-dlp's warnings in the same stream.

    The Python 3.10 deprecation notice arrives before the title, and taking
    "the first line that is not a warning" made it the video's title in the
    live workbench. The marker makes the answer explicit.
    """
    assert runner.TITLE_PREFIX == "VDT|"


def test_paths_are_recognised():
    assert runner._looks_like_path("/tmp/a.mp4")
    assert runner._looks_like_path("C:\\x\\a.MKV")
    assert not runner._looks_like_path("《我救不死你》")


def test_unique_path_does_not_overwrite(tmp_path):
    target = tmp_path / "a.mp4"
    target.write_bytes(b"1")
    second = runner._unique_path(str(target))
    assert second.endswith("a (2).mp4")


def test_largest_file_picks_the_media_output(tmp_path):
    (tmp_path / "small.mp4").write_bytes(b"x" * 10)
    (tmp_path / "big.mp4").write_bytes(b"x" * 100)
    (tmp_path / "parts").mkdir()
    assert runner._largest_file(str(tmp_path)).endswith("big.mp4")


def test_info_summary_prefers_the_tallest_video_stream():
    summary = runner._info_summary(
        {
            "title": " t ",
            "uploader": " u ",
            "duration": 10,
            "formats": [
                {"vcodec": "none", "acodec": "mp4a", "height": None, "filesize": 10},
                {"vcodec": "avc1", "height": 720, "width": 1280, "filesize": 200},
                {"vcodec": "avc1", "height": 1080, "width": 1920, "filesize": 300},
            ],
        }
    )
    assert summary["title"] == "t"
    assert summary["height"] == 1080
    assert summary["size"] == 300
