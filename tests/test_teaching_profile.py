"""Teacher profile, the USER.md mirror and the daily greeting.

The greeting's model call is replaced in every test: these tests pin the
deterministic fallback (which is what runs with no provider configured) and the
cache, not a provider.
"""

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.teaching import TeachingStore
from agent.teaching import profile as profile_mod
from channel.web.api import teaching as teaching_api
from channel.web.api.teaching import TeachingGreetingHandler, TeachingProfileHandler

PROFILE = {
    "name": "孙老师",
    "subjects": ["英语"],
    "classes": ["七（1）班", "七（2）班"],
    "textbook": "人教版（七年级上）",
    "school": "XX中学",
}


def _store(tmp_path):
    return TeachingStore(tmp_path / "teaching")


def _call(handler, method, workspace, *, payload=None, query=None):
    raw = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with patch.object(teaching_api, "_require_auth"), \
         patch.object(teaching_api.web, "header"), \
         patch.object(teaching_api.web, "data", return_value=raw), \
         patch.object(teaching_api.web, "input",
                      return_value=SimpleNamespace(**(query or {}))), \
         patch.object(teaching_api, "_get_workspace_root",
                      return_value=str(workspace)):
        return json.loads(getattr(handler(), method)())


def test_profile_defaults_validation_and_round_trip(tmp_path):
    store = _store(tmp_path)
    assert store.get_profile() == {
        "name": "", "subjects": [], "classes": [], "textbook": "", "school": "",
        "onboarded": False,
    }

    saved = store.save_profile(**PROFILE)
    assert saved["onboarded"] is True
    assert store.get_profile() == {**PROFILE, "onboarded": True}
    on_disk = json.loads((tmp_path / "teaching" / "profile.json").read_text(encoding="utf-8"))
    assert on_disk["name"] == "孙老师" and on_disk["onboarded"] is True

    # A partial save keeps the rest, and listing strings may be comma-joined.
    partial = store.save_profile(school="实验中学",
                                 classes="七（3）班，七（4）班、七（4）班")
    assert partial["name"] == "孙老师"
    assert partial["classes"] == ["七（3）班", "七（4）班"]

    with pytest.raises(ValueError):
        store.save_profile(name="")
    with pytest.raises(ValueError):
        store.save_profile(name="老" * 21)
    with pytest.raises(ValueError):
        store.save_profile(subjects=[f"科目{i}" for i in range(7)])
    with pytest.raises(ValueError):
        store.save_profile(classes=[f"班级{i}" for i in range(13)])
    with pytest.raises(ValueError):
        store.save_profile(subjects="英语\n语文")
    with pytest.raises(ValueError):
        store.save_profile(textbook="教" * 41)
    with pytest.raises(ValueError):
        store.save_profile(colour="red")

    # A rejected save leaves the stored profile byte-identical.
    before = (tmp_path / "teaching" / "profile.json").read_text(encoding="utf-8")
    with pytest.raises(ValueError):
        store.save_profile(name="新" * 21)
    assert (tmp_path / "teaching" / "profile.json").read_text(encoding="utf-8") == before


def test_save_profile_mirrors_user_md_and_keeps_surrounding_text(tmp_path):
    workspace = tmp_path / "workspace"
    (workspace / "teaching").mkdir(parents=True)
    user_md = workspace / "USER.md"
    user_md.write_text(
        "# 我的档案\n\n前面的话\n\n"
        "<!-- teacher-profile:start -->\n## 旧内容\n<!-- teacher-profile:end -->\n\n"
        "后面的话\n",
        encoding="utf-8",
    )

    response = _call(TeachingProfileHandler, "PUT", workspace, payload={**PROFILE, "textbook": ""})
    assert response["status"] == "success", response
    assert response["onboarded"] is True
    assert response["synced"] is True
    assert response["path"] == str(user_md)

    text = user_md.read_text(encoding="utf-8")
    assert text.startswith("# 我的档案\n\n前面的话\n\n")
    assert text.endswith("\n\n后面的话\n")
    assert "## 旧内容" not in text
    assert text.count("<!-- teacher-profile:start -->") == 1
    assert "## 老师信息" in text
    assert "- 姓名：孙老师" in text
    assert "- 学科：英语" in text
    assert "- 班级：七（1）班、七（2）班" in text
    assert "- 教材：" not in text, "an empty field must get no line"
    assert "- 学校：XX中学" in text

    # Saving again replaces the block instead of appending another copy.
    second = _call(TeachingProfileHandler, "PUT", workspace,
                   payload={**PROFILE, "name": "李老师", "school": ""})
    assert second["status"] == "success", second
    text = user_md.read_text(encoding="utf-8")
    assert text.count("<!-- teacher-profile:start -->") == 1
    assert "- 姓名：李老师" in text
    assert "孙老师" not in text
    assert "- 学校：" not in text
    assert text.startswith("# 我的档案\n\n前面的话\n\n")
    assert text.endswith("\n\n后面的话\n")


def test_user_md_gets_a_block_appended_when_unmarked(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    user_md = workspace / "USER.md"
    user_md.write_text("# USER.md\n\n手写的内容", encoding="utf-8")
    store = TeachingStore(workspace / "teaching")
    saved = store.save_profile(**PROFILE)

    result = profile_mod.sync_user_md(store, saved)
    assert result == {"synced": True, "path": str(user_md)}
    text = user_md.read_text(encoding="utf-8")
    assert text.startswith("# USER.md\n\n手写的内容\n\n<!-- teacher-profile:start -->")
    assert text.rstrip().endswith("<!-- teacher-profile:end -->")

    # No file at all: the block is the whole file, with a trailing newline.
    empty = tmp_path / "other"
    empty_store = TeachingStore(empty / "teaching")
    profile_mod.sync_user_md(empty_store, saved)
    assert (empty / "USER.md").read_text(encoding="utf-8").startswith("<!-- teacher-profile:start -->")


def test_greeting_uses_the_model_free_fallback_and_caches_per_day(tmp_path):
    workspace = tmp_path / "workspace"
    store = TeachingStore(workspace / "teaching")
    store.save_profile(**PROFILE)

    with patch.object(profile_mod, "motto_from_model", return_value=""):
        first = _call(TeachingGreetingHandler, "GET", workspace, query={"agent_id": ""})
        assert first["status"] == "success", first
        assert first["greeting"].endswith("，孙老师。")
        assert first["greeting"].split("，")[0] in ("早上好", "下午好", "晚上好")
        assert first["date"]
        # Famous lines carry their source, so the ceiling is wider than the old
        # one-line tip.
        assert 18 <= len(first["motto"]) <= 80
        assert first["cached"] is False

        second = _call(TeachingGreetingHandler, "GET", workspace, query={"agent_id": ""})
        assert second["cached"] is True
        assert second["motto"] == first["motto"]

        refreshed = _call(TeachingGreetingHandler, "GET", workspace,
                          query={"agent_id": "", "refresh": "1"})
        assert refreshed["cached"] is False
        # 换一句 must actually change the line, even when no model is reachable.
        assert refreshed["motto"] != first["motto"]
        # The hero renders the list's FIRST entry, so the rotated-to line has to
        # lead it -- otherwise the button looks dead (motto changed, display did
        # not).
        assert refreshed["motives"][0] == refreshed["motto"]

        # A second press keeps moving forward rather than oscillating.
        again = _call(TeachingGreetingHandler, "GET", workspace,
                      query={"agent_id": "", "refresh": "1"})
        assert again["motto"] not in (first["motto"], refreshed["motto"])
        assert again["motives"][0] == again["motto"]

    cached = json.loads((workspace / "teaching" / "daily_motto.json").read_text(encoding="utf-8"))
    assert cached["date"] == first["date"]
    # The last press is what the cache holds, and the stored line leads the list.
    assert cached["text"] == again["motto"]
    assert cached["motives"][0] == cached["text"]

    # No name yet: the fallback address is 老师, never 老师老师.
    blank = tmp_path / "blank"
    with patch.object(profile_mod, "motto_from_model", return_value=""):
        answer = _call(TeachingGreetingHandler, "GET", blank, query={"agent_id": ""})
    assert answer["status"] == "success", answer
    assert answer["greeting"].endswith("，老师。")
    assert "老师老师" not in answer["greeting"]


def test_a_generated_set_never_leads_with_the_line_on_screen(tmp_path, monkeypatch):
    """If the model happens to repeat the line the teacher is looking at, the
    click must still visibly change something -- so the set is rotated."""
    import time
    from datetime import date
    from agent.teaching.store import TeachingStore

    store = TeachingStore(str(tmp_path / "teaching"))
    store.save_profile(**PROFILE)
    current = "随风潜入夜，润物细无声。（杜甫《春夜喜雨》）"
    store.save_daily_motto("2026-11-22", current, motives=[current], source="fallback")

    monkeypatch.setattr(profile_mod, "motto_from_model",
                        lambda *a, **k: current + "\n相见时难别亦难，东风无力百花残。（李商隐《无题》）")
    profile_mod._warm_last.clear()
    assert profile_mod._warm_motto_async(
        store, store.get_profile(), date(2026, 11, 22), "2026-11-22", [], avoid=[current])

    for _ in range(50):
        cached = store.get_daily_motto()
        if cached.get("source") == "model":
            break
        time.sleep(0.05)
    cached = store.get_daily_motto()
    assert cached["source"] == "model"
    assert cached["text"] != current
    assert cached["motives"][0] == cached["text"]


def test_a_fully_cycled_set_asks_the_model_again():
    """After the teacher has seen all three lines, "换一句" must generate new
    ones instead of starting the same rotation over."""
    from datetime import datetime

    cached = {
        "date": "2026-11-22", "text": "a", "source": "model",
        "saved_at": datetime.now().timestamp(), "motives": ["a", "b", "c"], "spins": 2,
    }
    assert profile_mod._motto_needs_model(cached, "2026-11-22") is False
    cached["spins"] = 3
    assert profile_mod._motto_needs_model(cached, "2026-11-22") is True
    # The offline pool is replaced as soon as anything asks for a line.
    assert profile_mod._motto_needs_model({**cached, "source": "fallback", "spins": 0}, "2026-11-22") is True


def test_motto_asks_the_configured_primary_model(monkeypatch):
    """The motto must run on the model set in settings, not on whatever a
    long-lived bot instance was built with (the console can change it)."""
    from datetime import date

    import bridge.bridge as bridge_mod
    import config as config_mod

    captured = {}

    class FakeBot:
        args = {"model": "some-stale-model"}

        def reply_text(self, session, args=None):
            captured.update(args or {})
            return {"content": "海内存知己，天涯若比邻。（王勃《送杜少府之任蜀州》）", "completion_tokens": 8}

    # ``Bridge`` is a singleton getter: patch the instance's method.
    monkeypatch.setattr(bridge_mod.Bridge(), "get_bot", lambda typename: FakeBot())
    monkeypatch.setattr(config_mod, "conf", lambda: {"model": "deepseek-flash"})

    answer = profile_mod.motto_from_model(PROFILE, date(2026, 11, 20), [])
    assert "海内存知己" in answer
    assert captured.get("model") == "deepseek-flash"


def test_refresh_says_when_a_model_line_is_on_its_way(tmp_path):
    """The button can only stay "alive" while waiting if the answer says so:
    a fallback set is replaced by a model set, so the client is told."""
    from agent.teaching.store import TeachingStore

    store = TeachingStore(str(tmp_path / "teaching"))
    store.save_profile(**PROFILE)
    old = "海内存知己，天涯若比邻。（王勃《送杜少府之任蜀州》）"
    store.save_daily_motto("2026-11-22", old, motives=[old, "会当凌绝顶，一览众山小。（杜甫《望岳》）"],
                           source="fallback")
    profile_mod._warm_last.clear()
    profile_mod._warm_running.clear()

    with patch.object(profile_mod, "motto_from_model", return_value=""):
        answer = profile_mod.greeting(store, day="2026-11-22", refresh=True)

    assert answer["warming"] is True
    assert answer["motto"] != old
    assert answer["motives"][0] == answer["motto"]
    profile_mod._warm_last.clear()
    profile_mod._warm_running.clear()


def test_a_glued_cache_line_is_repaired_on_read(tmp_path):
    """Old caches stored the three lines glued together; the hero then showed a
    wall of text. Reading it must pick one real line and rewrite the cache."""
    from agent.teaching.store import TeachingStore

    store = TeachingStore(str(tmp_path / "teaching"))
    mashed = ("随风潜入夜，润物细无声。（杜甫《春夜喜雨》） "
              "1971年11月15日，英特尔发布世界首款商用微处理器4004。 "
              "明早把今天备好的例句写在黑板左上角…")
    store.save_daily_motto("2026-11-15", mashed, motives=[
        mashed,
        "纸上得来终觉浅，绝知此事要躬行。（陆游《冬夜读书示子聿》）",
        "1969 年的今天，人类第一次踏上月球。",
    ])

    answer = profile_mod.greeting(store, day="2026-11-15")
    assert answer["motto"] == "纸上得来终觉浅，绝知此事要躬行。（陆游《冬夜读书示子聿》）"
    assert len(answer["motives"]) == 2
    stored = json.loads((tmp_path / "teaching" / "daily_motto.json").read_text(encoding="utf-8"))
    assert stored["text"] == answer["motto"]
