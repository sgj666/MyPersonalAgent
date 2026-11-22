"""platforms.normalize: share text in, one canonical link out."""

import pytest

from agent.media.video import platforms
from agent.media.video.platforms import VideoUrlError


def _no_redirect(url):
    return ""


def test_extracts_url_from_share_text():
    text = (
        "在月球建座基地｜九上英语 读完这篇英语范文，月球科... "
        "https://xhslink.cn/o/7pn3092utJ7 内容复制后，前往【小红书】直接打开笔记。"
    )
    assert platforms.find_url(text) == "https://xhslink.cn/o/7pn3092utJ7"


def test_trailing_punctuation_is_not_part_of_the_url():
    assert platforms.find_url("看这个（https://b23.tv/BV1bGysz7EoD），很有用") == (
        "https://b23.tv/BV1bGysz7EoD"
    )


def test_douyin_share_text_resolves_to_canonical_video():
    link = platforms.normalize(
        "7.69 复制打开抖音，看看【线条不上班的作品】… https://v.douyin.com/FpfkdDQJ0iQ/ "
        "01/24 :2pm A@g.BT nqr:/",
        opener=lambda url: "https://www.douyin.com/video/7710212552923303202",
    )
    assert link.platform == platforms.DOUYIN
    assert link.video_id == "7710212552923303202"
    assert link.url == "https://www.douyin.com/video/7710212552923303202"


def test_xhs_short_link_keeps_xsec_token():
    target = (
        "https://www.xiaohongshu.com/discovery/item/6b0142e8000000001802a072"
        "?app_platform=android&xsec_token=CB--Ngv7GfDNz8ORoqJxC4Xc2Y9BLFTK8k_s12Ys3LkXg%3D"
    )
    link = platforms.normalize(
        "https://xhslink.cn/o/7pn3092utJ7", opener=lambda url: target
    )
    assert link.platform == platforms.XHS
    assert link.video_id == "6b0142e8000000001802a072"
    # Without this token the note page answers with a login wall, so dropping
    # it on the way to the canonical URL would break every share link.
    assert "xsec_token=CB--Ngv7GfDNz8ORoqJxC4Xc2Y9BLFTK8k_s12Ys3LkXg%3D" in link.url


def test_bilibili_keeps_page_number():
    link = platforms.normalize("https://www.bilibili.com/video/BV1bGysz7EoD?p=3")
    assert link.video_id == "BV1bGysz7EoD"
    assert link.url.endswith("?p=3")


def test_bilibili_av_and_short_host():
    link = platforms.normalize("https://b23.tv/BV1bGysz7EoD", opener=_no_redirect)
    assert (link.platform, link.video_id) == (platforms.BILIBILI, "BV1bGysz7EoD")


def test_short_link_cannot_escape_the_allowlist():
    with pytest.raises(VideoUrlError) as err:
        platforms.normalize(
            "https://v.douyin.com/abc/",
            opener=lambda url: "http://127.0.0.1:8080/secret",
        )
    assert err.value.reason == "unsupported"


def test_foreign_host_is_refused():
    with pytest.raises(VideoUrlError) as err:
        platforms.normalize("https://example.com/video/1")
    assert err.value.reason == "unsupported"


def test_text_without_link():
    with pytest.raises(VideoUrlError) as err:
        platforms.normalize("帮我下载一个视频")
    assert err.value.reason == "no_link"


def test_non_video_page_is_reported_as_such():
    with pytest.raises(VideoUrlError) as err:
        platforms.normalize("https://www.bilibili.com/read/cv123456")
    assert err.value.reason == "not_video"


def test_host_matching_is_suffix_aware():
    assert platforms.host_allowed("www.xiaohongshu.com")
    assert platforms.host_allowed("xhslink.cn")
    assert not platforms.host_allowed("xiaohongshu.com.evil.test")
    assert not platforms.host_allowed("")
