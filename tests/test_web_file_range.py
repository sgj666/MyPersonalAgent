"""Range requests: a <video> needs 206 partial content to play and seek."""

from urllib.parse import urlencode

import pytest
import web

from channel.web.api import files


@pytest.fixture
def app(tmp_path, monkeypatch):
    media = tmp_path / "a.mp4"
    media.write_bytes(bytes(range(256)) * 40)  # 10 240 bytes
    monkeypatch.setattr(files, "_require_auth", lambda: None)
    monkeypatch.setattr(files, "_is_path_allowed", lambda path: path == str(media))
    return web.application(("/api/file", "FileServeHandler"), vars(files)), media


def _get(app, media, range_header=None):
    url = "/api/file?" + urlencode({"path": str(media)})
    headers = {"Range": range_header} if range_header else None
    return app.request(url, headers=headers, method="GET")


def test_whole_file_still_answers_200(app):
    service, media = app
    response = _get(service, media)
    assert response.status == "200 OK"
    assert len(response.data) == 10_240
    assert response.headers["Accept-Ranges"] == "bytes"


def test_range_answers_206_with_the_requested_span(app):
    service, media = app
    response = _get(service, media, range_header="bytes=100-199")
    assert response.status.startswith("206")
    assert response.headers["Content-Range"] == "bytes 100-199/10240"
    assert len(response.data) == 100
    assert response.data == media.read_bytes()[100:200]


def test_open_ended_range_runs_to_the_end(app):
    service, media = app
    response = _get(service, media, range_header="bytes=10200-")
    assert response.status.startswith("206")
    assert response.headers["Content-Range"] == "bytes 10200-10239/10240"
    assert len(response.data) == 40


def test_suffix_range_returns_the_tail(app):
    service, media = app
    response = _get(service, media, range_header="bytes=-32")
    assert response.status.startswith("206")
    assert response.data == media.read_bytes()[-32:]


def test_range_past_the_end_is_416(app):
    service, media = app
    response = _get(service, media, range_header="bytes=99999-")
    assert response.status.startswith("416")
    assert response.headers["Content-Range"] == "bytes */10240"


def test_malformed_or_multi_range_falls_back_to_the_whole_file(app):
    service, media = app
    for header in ("bytes=0-1,5-6", "items=0-1", "bytes=abc"):
        response = _get(service, media, range_header=header)
        assert response.status == "200 OK"
        assert len(response.data) == 10_240


def test_parse_range_unit():
    assert files._parse_range("bytes=0-0", 10) == (0, 0)
    assert files._parse_range("bytes=5-", 10) == (5, 9)
    assert files._parse_range("bytes=-3", 10) == (7, 9)
    assert files._parse_range("bytes=8-100", 10) == (8, 9)
    assert files._parse_range("", 10) is None
    assert files._parse_range("bytes=20-30", 10) == (20, 9)


def test_large_files_are_streamed_rather_than_read_into_memory(tmp_path, monkeypatch):
    big = tmp_path / "big.mp4"
    big.write_bytes(b"0" * (files._STREAM_THRESHOLD + 10))
    monkeypatch.setattr(files, "_require_auth", lambda: None)
    monkeypatch.setattr(files, "_is_path_allowed", lambda path: path == str(big))
    service = web.application(("/api/file", "FileServeHandler"), vars(files))

    response = service.request("/api/file?" + urlencode({"path": str(big)}))
    assert response.status == "200 OK"
    assert len(response.data) == files._STREAM_THRESHOLD + 10
