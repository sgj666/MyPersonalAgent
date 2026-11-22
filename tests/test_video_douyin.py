"""douyin: reading the player's stream out of a rendered page."""

import pytest

from agent.media.video import douyin

# The shape a rendered Douyin page has: an xgplayer <video> whose <source> is
# the watermark-free progressive stream.
DOM = """
<html><head><title>没文化嘴硬挽尊的我： #两京十五日 - 抖音</title></head>
<body><div id="player"><video class="" autoplay="" playsinline="true">
<source class="" src="https://v26-webf.douyinvod.com/abc/def/video/tos/cn/x/?a=6383&amp;br=780&amp;bt=780" type="">
<source class="" src="https://v26-web.douyinvod.com/abc/def/video/tos/cn/x/?a=6383&amp;br=780" type="">
</video></div></body></html>
"""


def test_source_is_read_and_unescaped():
    found = douyin._video_source(DOM)
    assert found.startswith("https://v26-webf.douyinvod.com/")
    assert "&br=780" in found and "&amp;" not in found


def test_blob_sources_are_skipped():
    dom = '<video><source src="blob:https://www.douyin.com/123"></video>'
    assert douyin._video_source(dom) is None


def test_a_source_off_the_cdn_is_refused():
    dom = '<video><source src="https://evil.example.com/a.mp4"></video>'
    assert douyin._video_source(dom) is None


def test_play_addr_json_is_a_fallback():
    dom = '{"video":{"play_addr":{"url_list":["https://v3-web.douyinvod.com/x/video/tos/cn/y"]}}}'
    assert douyin._video_source(dom) == "https://v3-web.douyinvod.com/x/video/tos/cn/y"


def test_cdn_allowlist():
    assert douyin._cdn_allowed("https://v26-web.douyinvod.com/x")
    assert not douyin._cdn_allowed("https://douyinvod.com.evil.test/x")
    assert not douyin._cdn_allowed("file:///etc/passwd")


def test_title_drops_the_platform_suffix():
    assert douyin._title(DOM) == "没文化嘴硬挽尊的我： #两京十五日"


def test_missing_browser_is_a_reason_not_a_crash(monkeypatch):
    monkeypatch.setattr(douyin, "browser_path", lambda: None)
    with pytest.raises(douyin.DouyinError) as err:
        douyin.extract("https://www.douyin.com/video/1")
    assert err.value.reason == "no_browser"
