---
name: homework-card
description: 把教师给某个班的一句话课后作业，结合班级/科目/教学进度/最近成绩薄弱项，整理成分层作业卡 Card JSON，写到 artifacts/教学工具/card/<slug>.json。Use when the teacher asks for 作业卡片/作业单/分层作业, or the 作业卡片 page sends class + one-line intent + facts. 只产出 JSON；群图与 A4 由页面渲染。
---

# 作业卡片（Card JSON）

场景：教师给每个班级一句话说明课后作业。你结合**班级 / 科目 / 教学进度 / 最近成绩薄弱项**，把它整理成格式化的分层作业卡，输出 JSON。页面把它渲染成一张可发群的竖版图（1080×1440），另出 A4 打印版和答案版。你不写 HTML，不调用渲染命令。

## 1 入参

- `class_name`、`class_ids`、`subject`、`stage`、`book`、`unit`、`due`、`teacher`。
- `intent`：教师的一句话，例如「复习 be going to，明天默写短语」。这是题目范围的上限。
- `facts` / `stats`：来自 `/api/teaching/facts`，含进度、均分 `exam_avg`、薄弱项 `weak_skills[{name,rate}]`。
- 题源：`knowledge/教材/…`、`knowledge/评测/题库/…`。取原题时题干、选项、答案保持不变。

`intent` 缺失时问一句，不要自己编一套作业。

## 2 分层

`tier` 只能是 `basic`（基础）/ `advanced`（提升）/ `challenge`（挑战）。

- 无学情数据：按 6 / 3 / 1 配题（basic 6 题、advanced 3 题、challenge 1 题）。
- `exam_avg` < 70：basic 加到 7–8 题，challenge 可省略。
- `exam_avg` ≥ 85：basic 降到 4 题，advanced 4 题，challenge 2 题。
- 每个 `weak_skills` 里得分率最低的 1–2 项，basic 和 advanced 各至少 1 题对着它出。
- 1–4 个 section，每个 section ≤ 8 题；`no` 全卡连续编号。
- 总用时：小学 ≤ 20 分钟，初中 ≤ 30 分钟，高中 ≤ 40 分钟。

## 3 题型写法

题干 ≤ 60 字。`answer` 必须填（主观题写要点或评分口径）；答案只进答案版，学生卡不显示。`lines` 是作答留白行数（0–20 的整数）。

| type | 正例 | 反例 |
|---|---|---|
| `fill` | `"stem": "看望祖父母 ______ my grandparents", "answer": "visit"` | `"stem": "看望祖父母 visit ______"`（答案写进题干） |
| `choice` | `"stem": "— What are you going to do? — ______", "options": ["A. I'm going to see a film.", "B. I see a film."], "answer": "A"` | 不给 `options`，或选项里有两个都对 |
| `short` | `"stem": "用 be going to 写 3 句话说你的周末计划。", "lines": 3, "answer": "每句含 be going to + 动词原形，3 句即满分"` | `"answer": ""`（主观题也要评分口径） |
| `read` | `"stem": "读课本 Let's read 短文，写出 Sarah 周六下午的计划。", "lines": 2, "answer": "see a film"` | 把整段课文抄进 stem |
| `match` | `"stem": "连线：1 see a film 2 take a trip / A 去旅行 B 看电影", "answer": "1-B 2-A"` | 只写「连线」不给两列内容 |

## 4 summary（给家长的一句话）

- ≤ 40 字，说清今晚做什么、多久、重点。
- 语气克制，不用感叹号，不评价孩子。
- 正例：「今晚 20 分钟，抄写短语并写 3 句周末计划，重点是 be going to。」
- 反例：「孩子们加油！本次作业非常重要！！」

## 5 完整示例

```json
{"version": 1,
 "meta": {"class_name": "六(2)班", "class_ids": ["c_6_2"], "subject": "英语", "stage": "小学", "book": "人教PEP 六年级上", "unit": "Unit 3", "title": "Unit 3 课后作业", "date": "2026-11-12", "due": "周四", "teacher": "李老师"},
 "summary": "今晚 20 分钟，写短语和周末计划，重点是 be 动词。",
 "sections": [
  {"heading": "一、短语巩固", "tier": "basic", "hint": "每题 2 分",
   "items": [
    {"no": 1, "type": "fill", "stem": "看望祖父母 ______ my grandparents", "lines": 1, "answer": "visit"},
    {"no": 2, "type": "fill", "stem": "看电影 ______ a film", "lines": 1, "answer": "see"},
    {"no": 3, "type": "fill", "stem": "去旅行 take a ______", "lines": 1, "answer": "trip"},
    {"no": 4, "type": "match", "stem": "连线：1 tonight 2 next week / A 下周 B 今晚", "lines": 0, "answer": "1-B 2-A"},
    {"no": 5, "type": "choice", "stem": "He ______ going to visit his grandparents.", "options": ["A. am", "B. is", "C. are"], "answer": "B"},
    {"no": 6, "type": "choice", "stem": "— What are you going to do? — ______", "options": ["A. I'm going to see a film.", "B. I see a film."], "answer": "A"}
   ]},
  {"heading": "二、句型运用", "tier": "advanced", "hint": "每题 4 分",
   "items": [
    {"no": 7, "type": "short", "stem": "把 I see a film. 改成明天的计划。", "lines": 1, "answer": "I'm going to see a film tomorrow."},
    {"no": 8, "type": "short", "stem": "用 she 和 visit 写一句周末计划。", "lines": 1, "answer": "She is going to visit ... this weekend."},
    {"no": 9, "type": "read", "stem": "读课本 Let's read 短文，写出 Sarah 周六下午的计划。", "lines": 2, "answer": "She is going to see a film."}
   ]},
  {"heading": "三、我的周末", "tier": "challenge", "hint": "选做",
   "items": [
    {"no": 10, "type": "short", "stem": "用 be going to 写 3 句话说你的周末计划。", "lines": 3, "answer": "3 句，每句含 be going to + 动词原形与时间词"}
   ]}
 ],
 "footer": {"score": true, "parent_sign": true}}
```

## 6 落盘与回读

1. slug：`<班级>-<单元>-<作业名>`，去掉括号、空格、斜杠，例如 `六2-Unit3-课后作业`。
2. 用 `write` 写 `artifacts/教学工具/card/<slug>.json`，纯 JSON，不加 ``` 和注释。多个班就每班一份。
3. `read` 回读，自查：能解析、section 1–4、每 section ≤ 8 题、每题 `answer` 非空、stem ≤ 60 字。
4. 回报：路径、各层题量、预计用时、对着哪些薄弱项出了题。

## 7 禁止（怎么算失败）

- 编造教材页码或「课本原题」；查不到出处就不写页码。
- 把整段课文抄进题干。
- 把答案写进 `stem`，或 `answer` 留空。
- 超出教师 `intent` 的范围出题。
- `tier` 写成 basic/advanced/challenge 以外的值。
- 输出里夹解释文字导致 JSON 解析失败。
