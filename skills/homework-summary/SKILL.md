---
name: homework-summary
description: 由本次作业题目（Card JSON）+ 班级学情（facts/stats）生成三样：给家长的一句话、教师批改口径、薄弱点 3 条及 5 分钟补救动作，输出 JSON。Use when the teacher asks 总结这次作业/批改要点/给家长的话/作业薄弱点, or the 作业卡片 page requests a summary after the card is drafted.
---

# 作业总结

输入一次作业和班级学情，输出一份 JSON，页面分三处展示：家长一句话、批改口径、薄弱点。不写散文。

## 1 入参

- `card`：本次作业的 Card JSON（`artifacts/教学工具/card/<slug>.json`），没传路径就问。
- `facts` / `stats`：来自 `/api/teaching/facts`，含均分 `exam_avg`、薄弱项 `weak_skills[{name,rate}]`、未交人数 `homework_missing`。
- 可选：教师补一句「这次错得多的是……」。教师的话优先于 stats。

## 2 输出形状

```json
{"summary": "",
 "grading_notes": [{"section": "", "watch": "", "common_mistakes": []}],
 "weak_points": [{"point": "", "fix": ""}]}
```

- `summary`：给家长，≤ 40 字。说今晚做什么、多久、重点；不用感叹号。卡片里已有 `summary` 时可直接沿用或微调。
- `grading_notes`：每个 section 一条。`section` 照抄卡片的 `heading`；`watch` 写这一类题批改时看什么；`common_mistakes` 列 1–3 种常见错法。
- `weak_points`：恰好 3 条。`point` 写知识点和错在哪；`fix` 写下次课能做完的 5 分钟补救动作（谁做、做什么、怎么查）。

每个字符串 ≤ 40 字。

## 3 示例

```json
{"summary": "今晚 20 分钟，写短语和周末计划，重点是 be 动词。",
 "grading_notes": [
  {"section": "一、短语巩固", "watch": "动词拼写与固定搭配，大小写不扣分", "common_mistakes": ["visit 写成 vist", "take a trip 写成 do a trip"]},
  {"section": "二、句型运用", "watch": "be 是否随主语变、to 后是否原形", "common_mistakes": ["漏写 be", "he are going to", "going to visits"]},
  {"section": "三、我的周末", "watch": "3 句都含 be going to 和时间词", "common_mistakes": ["时间词缺失", "三句重复同一短语"]}
 ],
 "weak_points": [
  {"point": "be 动词随主语变化，he/she 后误用 are", "fix": "课前 5 分钟主语卡快问快答，教师抽 5 人口头检查"},
  {"point": "to 后动词加 s 或 ed", "fix": "黑板出 4 个错句，学生举手指错，同桌互改"},
  {"point": "阅读题找计划信息不准", "fix": "限时 3 分钟读 Let's read，用笔圈时间词，抽 3 人复述"}
 ]}
```

## 4 规则

- 只谈题目和学情，不评价学生个人，不出现学生姓名。
- 不写空话：「加强练习」「注意细节」「提高认识」都算失败，要写具体错法和具体动作。
- `weak_points` 依据顺序：教师补充 > `weak_skills` 得分率最低项 > 卡片里 challenge/advanced 题对应的知识点。没有学情数据时，在回报里说明「按题目推断」。
- 不引用 facts 里没有的数字（例如编一个「错误率 60%」）。
- 输出纯 JSON，不夹解释文字。

## 5 落盘与回报

- 页面调用时直接返回 JSON，不写文件。
- 教师要留存时，用 `write` 写到 `artifacts/教学工具/card/<slug>.summary.json`，`read` 回读确认能解析。
- 回报一句：三条薄弱点各是什么、依据来自哪里。

## 6 怎么算失败

- `weak_points` 不是 3 条，或某条没有 `fix`。
- `grading_notes` 漏了卡片里的某个 section，或 `section` 名与卡片不一致。
- 任一字符串超过 40 字。
- 出现学生姓名、个人评价或 facts 之外的数字。
