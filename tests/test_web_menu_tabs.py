# encoding:utf-8
"""Tabs and submenus in the menu document.

One page can appear once per tab (the five teaching tools are one view), and
an entry can carry those tabs as children instead of adding them beside it.
Uniqueness is therefore per (view, tab), not per view.
"""

import json
from unittest.mock import patch

import pytest

from channel.web.api.menu import MenuHandler, clean_menu


def _menu(*items):
    return {"groups": [{"id": "teach", "title": "", "items": list(items)}]}


def _builtin(view, item_id, **extra):
    return {"id": item_id, "type": "builtin", "view": view, **extra}


def _child(view, tab, title=""):
    return {"view": view, "tab": tab, "title": title}


def test_one_view_may_be_entered_on_several_tabs():
    menu = clean_menu(_menu(
        _builtin("teaching", "teach_plan", tab="plan"),
        _builtin("teaching", "teach_card", tab="card"),
    ))
    items = menu["groups"][0]["items"]
    assert [(i["view"], i.get("tab", "")) for i in items] == [("teaching", "plan"), ("teaching", "card")]


def test_a_parent_entry_lists_its_tabs_as_children():
    menu = clean_menu(_menu(_builtin("teaching", "teaching", children=[
        _child("teaching", "plan"),
        _child("teaching", "card", "  作业 卡片 "),
    ])))
    item = menu["groups"][0]["items"][0]
    assert item["view"] == "teaching" and "tab" not in item
    assert item["children"] == [
        {"view": "teaching", "tab": "plan", "title": ""},
        {"view": "teaching", "tab": "card", "title": "作业 卡片"},
    ]


def test_a_parent_entry_is_valid_without_children():
    for raw in (_builtin("teaching", "teaching"),
                _builtin("teaching", "teaching", children=[])):
        menu = clean_menu(_menu(raw))
        assert "children" not in menu["groups"][0]["items"][0]


def test_a_repeated_view_and_tab_is_refused():
    with pytest.raises(ValueError):
        clean_menu(_menu(_builtin("teaching", "a", tab="plan"),
                         _builtin("teaching", "b", tab="plan")))
    with pytest.raises(ValueError):
        clean_menu(_menu(_builtin("teaching", "teaching", children=[
            _child("teaching", "plan"), _child("teaching", "plan")])))
    # A child that repeats its parent's own pair is the same entry twice.
    with pytest.raises(ValueError):
        clean_menu(_menu(_builtin("teaching", "teaching", tab="plan", children=[
            _child("teaching", "plan")])))
    # Children are unique against entries in other groups too.
    with pytest.raises(ValueError):
        clean_menu({"groups": [
            {"id": "a", "items": [_builtin("teaching", "a", tab="plan")]},
            {"id": "b", "items": [_builtin("teaching", "b", children=[
                _child("teaching", "plan")])]},
        ]})


@pytest.mark.parametrize("tab", ["Plan", "plan-1", "plan.1", "a" * 21, "计划"])
def test_a_tab_must_look_like_a_tab(tab):
    with pytest.raises(ValueError):
        clean_menu(_menu(_builtin("teaching", "t", tab=tab)))


@pytest.mark.parametrize("child", [
    {"tab": "plan"},
    {"view": "teaching"},
    {"view": "Teaching", "tab": "plan"},
    {"view": "teaching", "tab": "Plan"},
])
def test_a_child_needs_a_view_and_a_tab(child):
    with pytest.raises(ValueError):
        clean_menu(_menu(_builtin("teaching", "teaching", children=[child])))


def test_a_submenu_holds_at_most_eight_children():
    tabs = ["plan", "courseware", "card", "advice", "schedule", "intro", "review",
            "exam", "holiday"]
    clean_menu(_menu(_builtin("teaching", "teaching",
                              children=[_child("teaching", t) for t in tabs[:8]])))
    with pytest.raises(ValueError):
        clean_menu(_menu(_builtin("teaching", "teaching",
                                  children=[_child("teaching", t) for t in tabs])))


def test_an_unknown_tab_is_kept_for_the_clients_that_know_it():
    # Only shape is validated: a tab this build's teaching view does not show
    # is still the user's, and a client that lacks it lands on its default tab.
    menu = clean_menu(_menu(_builtin("teaching", "t", tab="not_a_tool")))
    assert menu["groups"][0]["items"][0]["tab"] == "not_a_tool"


@pytest.fixture
def menu_path(tmp_path):
    path = tmp_path / "system" / "menu.json"
    with patch("common.state_dir.menu_file", return_value=path), \
         patch("channel.web.api.menu._require_auth"):
        yield path


def _post(menu):
    with patch("channel.web.api.menu.web.data",
               return_value=json.dumps({"menu": menu}).encode()), \
         patch("channel.web.api.menu.web.header"):
        return json.loads(MenuHandler().POST())


def _get():
    with patch("channel.web.api.menu.web.header"):
        return json.loads(MenuHandler().GET())


def test_a_submenu_round_trips_through_the_saved_menu(menu_path):
    saved = _post(_menu(_builtin("teaching", "teaching", children=[
        _child("teaching", "plan"),
        _child("teaching", "card", "作业卡片"),
    ])))
    assert saved["status"] == "success"
    assert _get()["menu"] == saved["menu"]
    assert saved["menu"]["groups"][0]["items"][0]["children"] == [
        {"view": "teaching", "tab": "plan", "title": ""},
        {"view": "teaching", "tab": "card", "title": "作业卡片"},
    ]


def test_sibling_tabs_of_one_view_round_trip(menu_path):
    menu = _menu(_builtin("teaching", "teach_plan", tab="plan"),
                 _builtin("teaching", "teach_advice", tab="advice"))
    assert _post(menu)["status"] == "success"
    assert [(i["id"], i["tab"]) for i in _get()["menu"]["groups"][0]["items"]] == [
        ("teach_plan", "plan"), ("teach_advice", "advice")]
