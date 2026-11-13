---
name: homework-card
description: 把教师给某个班的一句话课后作业，结合班级/科目/教学进度/最近成绩薄弱项，整理成分层作业通知卡 Card JSON，写到 artifacts/教学工具/card/<slug>.json。Use when the teacher asks for 作业卡片/作业单/分层作业, or the 作业卡片 page sends class + one-line intent + facts. 只产出 JSON；群图与 A4 由页面渲染。
---

# 作业卡片（Card JSON）

场景：教师给每个班级一句话说明今晚的课后作业。你把它整理成一张**布置通知卡**：学生打开就知道做什么、做多久、什么时候交。

**这是通知，不是作业本。** 卡上没有作答横线、没有括号、没有姓名/得分/家长签字；答案只作为「讲评要点」附录，默认不进学生卡。

## 1 入参

- `class_name`、`class_ids`、`subject`、`stage`、`book`、`unit`、`due`、`teacher`。
- `intent`：教师的一句话，例如「Unit 3 单词抄写 3 遍，单元测试卷一张，试卷订正」。**条目范围以它为准，不要扩写成一整套题。**
- `facts` / `stats`：来自 `/api/teaching/facts`，含进度差、均分 `exam_avg`、薄弱项 `weak_skills[{name,rate}]`。

`intent` 缺失时问一句，不要自己编一套作业。

## 2 条目怎么写

每个 `items[]` 是**一件具体的事**，不是一道题。

| 字段 | 要求 |
|---|---|
| `type` | 固定 `"task"` |
| `stem` | 干什么，≤ 40 字。动词开头，写清范围与数量 |
| `requirement` | 可选补充，≤ 80 字：抄哪些词、订正到什么程度、用红笔还是蓝笔 |
| `duration` | 预计分钟，1–180 的整数。凭经验给，别写 0 |
| `answer` | 可选。只有需要讲评时才写一句要点（只进教师附录） |

正例：

```json
{"no": 1, "type": "task", "stem": "Unit 3 单词抄写 3 遍",
 "requirement": "visit / picnic / cinema / see a film", "duration": 10}
{"no": 2, "type": "task", "stem": "单元测试试卷一张", "duration": 20}
{"no": 3, "type": "task", "stem": "试卷订正", "requirement": "错题抄题重做，红笔标出错因", "duration": 10}
```

反例（怎么算写错）：

- `"stem": "看望祖父母 ______ my grandparents"` —— 这是题目，带作答横线。
- `"stem": "用 be going to 写两句话描述你的周末：", "lines": 3` —— 这是练习卷的题，`lines` 在新契约里没用。
- `"stem": "做作业"` —— 太笼统，学生不知道做什么。
- 编造「课本 P32 第 5 题」这种查不到出处的页码。

## 3 分层与总量

`tier` 只能是 `basic`（必做）/ `advanced`（提高）/ `challenge`（挑战）。

- 默认只出 1 个 `basic` 分组；教师明确要分层才加 `advanced` / `challenge`。
- 有学情时：`weak_skills` 得分率最低的 1–2 项，至少一条 `basic` 条目对着它。
- `exam_avg` < 70 → 条目少而具体（2–3 条），把订正/基础巩固放必做。
- `exam_avg` ≥ 85 → 可加 1 条 `challenge`（如「自选题材写 5 句话」）。
- 1–4 个 section，每个 section ≤ 8 条，`no` 全卡连续编号。
- 合计用时：小学 ≤ 20 分钟，初中 ≤ 30 分钟，高中 ≤ 40 分钟；超了就删条目，不要拉长到深夜。

## 4 summary（给学生的提醒）

- ≤ 40 字，写清**提交方式和注意事项**，例如「明天上课前交给课代表，订正用红笔」。
- **不要写给家长的话**：中学生自己交作业，卡片上没有家长栏。
- 语气克制，不用感叹号，不评价学生。

## 5 完整示例

```json
{"version": 1,
 "meta": {"class_name": "七(3)班", "class_ids": ["c_7_3"], "subject": "英语", "stage": "初中",
          "book": "人教新版", "unit": "Unit 3", "title": "Unit 3 课后作业",
          "date": "2026-11-12", "due": "2026-11-13", "teacher": "李老师"},
 "summary": "明天上课前交给课代表，订正用红笔。",
 "sections": [
  {"heading": "必做", "tier": "basic", "hint": "全班都做",
   "items": [
    {"no": 1, "type": "task", "stem": "Unit 3 单词抄写 3 遍",
     "requirement": "visit / picnic / cinema / see a film", "duration": 10},
    {"no": 2, "type": "task", "stem": "单元测试试卷一张", "duration": 20}
   ]},
  {"heading": "挑战", "tier": "challenge", "hint": "选做",
   "items": [
    {"no": 3, "type": "task", "stem": "试卷订正",
     "requirement": "错题抄题重做，红笔标出错因", "duration": 10}
   ]}
 ],
 "footer": {"score": false}}
```

## 6 落盘与回读

1. slug：`<班级>-<单元>-<作业名>`，去掉括号、空格、斜杠，例如 `七3-Unit3-课后作业`。
2. 用 `write` 写 `artifacts/教学工具/card/<slug>.json`，纯 JSON，不加 ``` 和注释。多个班就每班一份。
3. `read` 回读，自查：能解析、section 1–4、每 section ≤ 8 条、每条 `duration` 是 1–180 的整数、`stem` ≤ 40 字、`type` 全是 `task`。
4. 回报：路径、条目数、合计用时、对着哪些薄弱项出的条目。

## 7 禁止（怎么算失败）

- 把题目/题干/选项/作答横线写进卡片（那是作业本，不是通知）。
- 写「给家长的话」「家长签字」「得分」等家长栏位。
- 编造教材页码或「课本原题」。
- `duration` 缺失，或写成 0 / 超过 180。
- 超出教师 `intent` 的范围加作业。
- 输出里夹解释文字导致 JSON 解析失败。
