"""A slash command that names an installed skill runs that skill.

The backend has no `/skill <name>`; the only way to invoke a skill by name is
this rewrite, which turns the message into an instruction before the agent runs.
"""
import os

import pytest

import plugins
from bridge.context import Context, ContextType
from plugins.event import EventContext

_old = plugins.instance.current_plugin_path
plugins.instance.current_plugin_path = os.path.join(os.getcwd(), "plugins", "cow_cli")
try:
    import plugins.cow_cli.cow_cli  # noqa: F401
finally:
    plugins.instance.current_plugin_path = _old

CowCli = plugins.instance.plugins["COW_CLI"]


class _Manager:
    def __init__(self, names, disabled=()):
        self.skills = {name: object() for name in names}
        self.skills_config = {name: {"enabled": name not in disabled} for name in names}


class _Agent:
    def __init__(self, manager):
        self.skill_manager = manager


def _context(text):
    context = Context(ContextType.TEXT, text)
    context.kwargs["session_id"] = "s1"
    return EventContext("test", {"context": context})


@pytest.fixture
def plugin(monkeypatch):
    plugin = CowCli()
    monkeypatch.setattr(CowCli, "_get_agent", lambda self, session_id: _Agent(_Manager(
        ["teaching-advice", "homework-card"], disabled=["homework-card"])))
    return plugin


def test_a_skill_name_expands_into_an_instruction(plugin):
    e_context = _context("/teaching-advice 看看七(3)班的学情")
    plugin.on_handle_context(e_context)
    assert e_context["context"].content == "请使用技能「teaching-advice」完成：\n看看七(3)班的学情"
    assert "reply" not in e_context.econtext


def test_a_skill_without_arguments_still_expands(plugin):
    e_context = _context("/teaching-advice")
    plugin.on_handle_context(e_context)
    assert e_context["context"].content.startswith("请使用技能「teaching-advice」完成")


def test_a_disabled_skill_is_left_alone(plugin):
    e_context = _context("/homework-card 布置作业")
    plugin.on_handle_context(e_context)
    assert e_context["context"].content == "/homework-card 布置作业"


def test_an_unknown_slash_is_left_alone(plugin):
    e_context = _context("/not-a-skill hello")
    plugin.on_handle_context(e_context)
    assert e_context["context"].content == "/not-a-skill hello"
