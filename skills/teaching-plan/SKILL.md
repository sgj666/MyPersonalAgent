---
name: teaching-plan
description: 生成学期或单元教学计划周次表 JSON（weeks[]），写到 artifacts/教学工具/plan/<slug>.json，由接口以 overwrite:false 写入教学进度。Use when the teacher asks 教学计划/学期进度表/单元课时安排, or opens the 教学计划 page.
---

# 教学计划（weeks JSON）

把「学期 / 单元范围」变成一张周次表 JSON。页面可编辑这张表，再由接口写入教学进度。

## 1 入参

- 学期、教材版本册次、单元范围（全册 / 某几个单元）。
- `weeks_total`：总周数；`periods_per_week`：每周课时；`start_week`：起始周（默认 1）。
- 校历约束：期中、期末、月考、节假日、运动会占用的周或课时。
- 已授进度：来自 `/api/teaching/progress` 或教师说明，只作参考，不改。

最多问两个关键问题（单元范围、每周课时），其余按常规取值，在回报里写明假设。

## 2 输出

```json
{"weeks": [
  {"week": 1, "unit": "Unit 1", "topic": "How can I get there? 听说", "periods": 2, "goal": "能用 Where is ...? 问路并指路", "assess": "两人问路对话展示"},
  {"week": 1, "unit": "Unit 1", "topic": "How can I get there? 阅读", "periods": 2, "goal": "能读懂路线描述并画出路线", "assess": "路线图正确率"},
  {"week": 9, "unit": "期中", "topic": "期中复习 Unit 1–3", "periods": 4, "goal": "能完成 Unit 1–3 核心句型问答", "assess": "复习小测"},
  {"week": 18, "unit": "期末", "topic": "期末复习 全册", "periods": 4, "goal": "能独立完成全册词汇与句型综合题", "assess": "期末模拟卷"}
 ]}
```

字段：`week`（整数，第几周）、`unit`、`topic`、`periods`（整数）、`goal`、`assess`。同一周可以有多行（按课型拆），同一周的 `periods` 合计不超过 `periods_per_week`。

## 3 规则

- **课时合计必须对得上**：所有行 `periods` 之和 = `weeks_total × periods_per_week` − 校历占用课时。回报里写出算式，例如「18 × 4 − 4（运动会）= 68」。
- **自动留出复习周**：期中前 1 周、期末前 1–2 周写成复习行，`unit` 写「期中」或「期末」，`topic` 写「期中复习 Unit 1–3」这类，不藏进单元行。
- 考试本身占用的课时不排课，在算式里扣掉。
- 每个单元按课型拆行（听说 / 阅读 / 语法 / 写作），合计等于该单元分配课时。
- `goal` 是可检验的行为（「能复述课文第 2 段」），不写「学习 Unit 3」。
- `assess` 写具体评价方式（口头展示、小测、作品），不写「课堂观察」带过。
- 已授的单元照常列出（保持周次完整），不要删行。
- 表内不写学生姓名。

## 4 不覆盖已授记录

- 你的输出**只是计划**。写入教学进度由接口 `POST /api/teaching/progress/import` 完成，固定 `overwrite: false`：已有条目只补空字段，已授课时的记录一律不动。
- 不要自己调用写进度的接口去覆盖；不要建议教师改 `overwrite`。
- 教师问「会不会冲掉已上的课」：回答不会，已授记录保持原样，冲突会在页面右栏列出。

## 5 落盘与回读

1. slug：`<学期>-<教材简称>-<范围>`，去掉空格与斜杠，例如 `2026秋-人教PEP六上-全册`。
2. 用 `write` 写 `artifacts/教学工具/plan/<slug>.json`，纯 JSON，不加 ``` 和注释。
3. `read` 回读，自查：能解析、`week` 和 `periods` 是整数、课时合计符合算式、期中期末复习行都在。
4. 回报：路径、总周数、总课时算式、覆盖单元、做了哪些假设。
5. 计划调整时改同一个文件，不另起新文件。

## 6 怎么算失败

- 课时合计与算式不符，或某周超过每周课时。
- 没有期中 / 期末复习行。
- `goal` 写成「学习某单元」。
- 删掉了已授单元的行，或建议用 `overwrite: true`。
