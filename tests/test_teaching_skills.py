"""Contract tests for the five teacher skills shipped under skills/."""

import os
import re

import pytest

from agent.skills.frontmatter import parse_frontmatter, strip_frontmatter
from agent.skills.loader import SkillLoader

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS_DIR = os.path.join(REPO_ROOT, "skills")

CJK = re.compile(r"[\u4e00-\u9fff]")

# Keys the loader and the skill format actually understand; anything else is a
# typo the loader would silently ignore.
ALLOWED_FRONTMATTER_KEYS = {
    "name",
    "description",
    "license",
    "metadata",
    "disable-model-invocation",
    "user-invocable",
}

# skill name -> text that must appear in the body, so a rewrite cannot quietly
# drop the output path or the command the skill is contracted to run.
REQUIRED_TEXT = {
    "lesson-plan": ["knowledge/教案/"],
    "courseware-ppt": [
        "from agent.tools.pptx import build_deck",
        "artifacts/",
        "getsize",
        "ValueError",
    ],
    "homework-card": ["@media print", "artifacts/作业卡片/", "PNG"],
    "teaching-advice": ["memory_search"],
    "teaching-plan": ["task_board"],
}


def _skill_path(name):
    return os.path.join(SKILLS_DIR, name, "SKILL.md")


@pytest.mark.parametrize("name", sorted(REQUIRED_TEXT))
def test_frontmatter_parses_with_repo_loader(name):
    path = _skill_path(name)
    with open(path, encoding="utf-8") as handle:
        content = handle.read()

    frontmatter = parse_frontmatter(content)
    assert set(frontmatter) <= ALLOWED_FRONTMATTER_KEYS
    assert set(frontmatter) >= {"name", "description"}
    assert frontmatter["name"] == name
    assert isinstance(frontmatter["description"], str)
    assert frontmatter["description"].strip()

    result = SkillLoader().load_skills_from_dir(os.path.join(SKILLS_DIR, name), "custom")
    assert result.diagnostics == []
    assert [skill.name for skill in result.skills] == [name]
    assert result.skills[0].description == frontmatter["description"]


@pytest.mark.parametrize("name", sorted(REQUIRED_TEXT))
def test_instructions_are_chinese_and_keep_the_contract(name):
    with open(_skill_path(name), encoding="utf-8") as handle:
        content = handle.read()

    body = strip_frontmatter(content)
    assert CJK.search(body), "instructions must be written in Chinese"

    for expected in REQUIRED_TEXT[name]:
        assert expected in body, f"{name} must mention {expected!r}"

    assert "http://" not in body and "https://" not in body, (
        f"{name} must stay offline: no network URLs"
    )


def test_courseware_ppt_documents_the_renderer_contract():
    with open(_skill_path("courseware-ppt"), encoding="utf-8") as handle:
        body = strip_frontmatter(handle.read())

    # The renderer's hard limits are what the model has to respect when it
    # writes a spec, so they belong in the skill, not only in an error message.
    assert "40" in body
    assert "200" in body
    for theme in ("lecture", "activity", "review"):
        assert theme in body
    assert ".pptx" in body


def test_python_pptx_is_a_required_dependency():
    with open(os.path.join(REPO_ROOT, "requirements.txt"), encoding="utf-8") as handle:
        lines = [line.strip() for line in handle if line.strip()]

    assert any(
        line.startswith("python-pptx>=") and line.split(">=")[1].strip()
        for line in lines
    )
