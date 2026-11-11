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
        assert 18 <= len(first["motto"]) <= 30
        assert first["cached"] is False

        second = _call(TeachingGreetingHandler, "GET", workspace, query={"agent_id": ""})
        assert second["cached"] is True
        assert second["motto"] == first["motto"]

        refreshed = _call(TeachingGreetingHandler, "GET", workspace,
                          query={"agent_id": "", "refresh": "1"})
        assert refreshed["cached"] is False
        assert refreshed["motto"] == first["motto"], "the date's sentence is deterministic"

    cached = json.loads((workspace / "teaching" / "daily_motto.json").read_text(encoding="utf-8"))
    assert cached == {"date": first["date"], "text": first["motto"]}

    # No name yet: the fallback address is 老师, never 老师老师.
    blank = tmp_path / "blank"
    with patch.object(profile_mod, "motto_from_model", return_value=""):
        answer = _call(TeachingGreetingHandler, "GET", blank, query={"agent_id": ""})
    assert answer["status"] == "success", answer
    assert answer["greeting"].endswith("，老师。")
    assert "老师老师" not in answer["greeting"]
