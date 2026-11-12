# Skills

Skills are reusable instruction sets that extend the agent's capabilities. Each skill is a `SKILL.md` file in its own directory, providing specialized knowledge, workflows, and tool integrations for specific tasks.

## Skill Hub

Browse, search, and install skills from [Cow Skill Hub](https://skills.cowagent.ai/).

Open source: [github.com/zhayujie/cow-skill-hub](https://github.com/zhayujie/cow-skill-hub)

## Install Skills

Install skills from multiple sources via chat (`/skill`) or terminal (`cow skill`):

```bash
/skill install <name>                   # From Skill Hub
/skill install <owner>/<repo>           # From GitHub
/skill install clawhub:<name>           # From ClawHub
/skill install linkai:<code>            # From LinkAI
/skill install <url>                    # From URL (zip or SKILL.md)
```

List all available remote skills:

```bash
/skill list --remote
```

## Manage Skills

```bash
/skill list                  # List installed skills
/skill info <name>           # View skill details
/skill enable <name>         # Enable a skill
/skill disable <name>        # Disable a skill
/skill uninstall <name>      # Uninstall a skill
```

> In terminal, replace `/skill` with `cow skill`.

## Teaching Skills

教学工具页面只传结构化参数，输出契约以各 SKILL.md 为准（Deck / Card JSON 见 `docs/plans/teaching-tools-implementation.md` §2、§3）。

| Skill | 输入契约 | 产出 |
|---|---|---|
| `lesson-plan` | 学段/学科/教材/单元/课型/课时 + `material_paths[]` + 班级；`mode` 为 `outline` 或 `draft` | 先 7 行大纲；确认后写 `knowledge/教案/<学段>-<学科>-<单元>-<课型>.md`，文末附引用来源 |
| `courseware-ppt` | 教案路径或表单字段 | Deck JSON（13 种 layout，10–16 页，含讲稿）→ `artifacts/教学工具/deck/<slug>.json` |
| `homework-card` | 班级 + 一句话作业意图 + facts/stats（薄弱项、均分） | 分层 Card JSON → `artifacts/教学工具/card/<slug>.json` |
| `homework-summary` | Card JSON + facts/stats | `{summary, grading_notes[], weak_points[3]}` JSON |
| `teaching-advice` | 班级 + 单元 + 关注点 + `/api/teaching/facts` 的 facts/stats | `{facts[], actions[3–5]}` JSON，每条 action 可转任务 |
| `teaching-plan` | 学期、教材、单元范围、周数、每周课时、校历 | `{weeks[]}` JSON → `artifacts/教学工具/plan/<slug>.json`，由接口 `overwrite:false` 写入进度 |

渲染（.pptx / HTML / 群图 / A4）由 `/api/teaching/render` 完成，技能不调用渲染命令。

## Skill Structure

```
skills/
  my-skill/
    SKILL.md          # Required: skill definition
    scripts/          # Optional: bundled scripts
    resources/        # Optional: reference files
```

`SKILL.md` uses YAML frontmatter:

```markdown
---
name: my-skill
description: Brief description of what the skill does
metadata: {"cow":{"emoji":"🔧","requires":{"bins":["tool"],"env":["API_KEY"]}}}
---

# My Skill

Instructions, examples, and usage patterns...
```

### Frontmatter Fields

| Field | Description |
|---|---|
| `name` | Skill name (must match directory name) |
| `description` | Brief description (required) |
| `metadata.cow.emoji` | Display emoji |
| `metadata.cow.always` | Always include this skill (default: false) |
| `metadata.cow.requires.bins` | Required binaries |
| `metadata.cow.requires.env` | Required environment variables |
| `metadata.cow.requires.config` | Required config paths |
| `metadata.cow.os` | Supported OS (e.g., `["darwin", "linux"]`) |

## Skill Loading Order

Skills are loaded from two locations (higher precedence overrides lower):

1. **Builtin skills** (lower): `<project_root>/skills/` — shipped with the codebase
2. **Custom skills** (higher): `~/cow/skills/` — installed via `cow skill install` or skill creator

Skills with the same name in the custom directory override builtin ones.

## Create & Contribute

See the [Skill Creation docs](https://docs.cowagent.ai/skills/create) for details, or submit your skill to [Skill Hub](https://skills.cowagent.ai/submit).
