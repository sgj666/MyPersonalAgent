---
name: teaching-advice
description: 读班级学情事实（/api/teaching/facts 的 facts/stats），只做判断与行动，输出 {facts, actions[]} JSON，每条 action 能直接变成看板任务。Use when the teacher asks 怎么上这节课/学情分析与对策/教学改进意见, or opens the 教学建议 page with class + unit + focus + facts.
---

# 教学建议（吃事实）

回答「这个班接下来怎么做」。事实由系统算好，你只做**判断 + 行动**，不复述事实，不写教学法综述。

## 1 入参

```json
{"class_name": "六(2)班", "unit": "Unit 3", "focus": "作业",
 "facts": [{"key": "progress_gap", "label": "教学进度", "value": "落后 2 课时", "detail": "计划 12，已授 10"},
           {"key": "homework_missing", "label": "未交作业", "value": "5 人", "detail": "近两次均未交"},
           {"key": "exam_weak", "label": "薄弱项", "value": "阅读理解 41%", "detail": "单元测"}],
 "stats": {"students": 48, "planned": 12, "taught": 10, "homework_missing": 5,
           "exam_avg": 78, "weak_skills": [{"name": "阅读理解", "rate": 0.41}]}}
```

- `focus`：课堂参与 / 分层 / 作业 / 进度等，决定 actions 优先排哪类。
- `facts` 为空或缺失：先请页面调用 `/api/teaching/facts`；仍为空就只给通用的 3 条，并在每条 `expected` 写「待有数据后复核」。
- 可补读 `knowledge/班级与学情/`、`knowledge/教研/`，引用时写出路径。

## 2 输出

```json
{"facts": ["progress_gap", "homework_missing", "exam_weak"],
 "actions": [
  {"title": "明早 10 分钟限时阅读", "when": "周三早读", "owner": "李老师",
   "steps": ["选 Unit 3 第二篇短文", "限时 6 分钟读，圈时间词", "4 分钟核对 3 道细节题"],
   "expected": "下次单元测阅读理解得分率高于 41%；若早读被占，改到周四课前"},
  {"title": "5 人未交作业一对一跟进", "when": "今天放学前", "owner": "课代表",
   "steps": ["课代表列出 5 人名单交老师", "老师逐个问原因并定补交时间"],
   "expected": "周五前 5 人全部补交；仍未交的通知家长"},
  {"title": "压缩操练补回 2 课时", "when": "下周", "owner": "李老师",
   "steps": ["合并 Part B 两课时操练", "听说练习改为课后音频"],
   "expected": "下周末已授课时与计划持平；风险：听说练习量下降，周测里观察"}
 ]}
```

- `facts`：本次判断依据的 fact `key` 列表，原样取自入参，不改写、不新增。
- `actions`：3–5 条。每条都能直接写成任务：
  - `title`：动词开头，≤ 20 字。
  - `when`：具体时间点（今天放学前、周三早读、下周一第 2 节），不写「近期」「适时」。
  - `owner`：教师、课代表、备课组等角色；不写学生姓名。
  - `steps`：2–4 步，每步一句能照做的动作。
  - `expected`：可验收的结果（数量、比例、截止时间），并写一句风险或备选（原「风险与备选」并入这里）。
- 排序：与 `focus` 最相关、最紧急的放第一条。

## 3 硬规则

- **facts/stats 里没有的数字，一个都不许出现在输出里。** 示例里的 41%、5 人、2 课时都来自入参；要说「提高到 60%」而入参没有 60，就改成「高于 41%」。
- 不复述事实：不写「本班进度落后 2 课时，说明……」这类句子，判断直接体现在 action 的 title 和 steps 里。
- 每条 action 必须能在一周内验收；做不到的拆小。
- 不写空话：「加强师生互动」「关注学困生」不算 action。
- 涉及具体学生用角色或人数，不写真实姓名和隐私。
- 输出纯 JSON，不夹 Markdown。

## 4 追问

- 「再具体点」：把 steps 改成逐句课堂指令 + 时间 + 检查方式。
- 「换个思路」：保留 facts，换一组 actions（讲授式 → 任务式 / 竞赛式 / 同伴互评）。
- 「写进教案」：提示可以让 lesson-plan 并入教学过程，不要静默改教案文件。

## 5 落盘

页面调用时直接返回 JSON。教师要求留存时，用 `write` 写到 `artifacts/教学工具/advice/<班级>-<单元>-<日期>.json`，`read` 回读确认能解析，回报路径。

## 6 怎么算失败

- 输出里出现入参没有的数字。
- `actions` 少于 3 条或多于 5 条；任一条缺 `when` 或 `expected`。
- `expected` 写成「效果提升」「学生更积极」这类无法验收的话。
- `facts` 里出现入参之外的 key。
