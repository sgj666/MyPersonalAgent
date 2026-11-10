---
name: courseware-ppt
description: 由教案或表单生成真实 .pptx 课件。Use when the teacher asks to 做课件/生成PPT/把教案做成幻灯片, or chooses 新建教案 or 已有教案 on the 课件生成 page. Calls the local python-pptx renderer and writes artifacts/<slug>.pptx.
---

# 课件生成（本地 .pptx）

教案 → 结构化 JSON → 本地渲染器 → `artifacts/<slug>.pptx`。全程离线：不调用 Office、不访问网络、不下载模板。

## 1 素材来源

按顺序找：

1. 教师指定了教案：`read` `knowledge/教案/<文件名>.md`。
2. 教师直接给了表单/口述：以表单为准，缺的字段按「学段、学科、教材、单元、课型、课时、目标」补齐后再动手。
3. 都没给：先反问一节课的单元主题与课型，不要凭空编一节课。

从教案里取：课题、目标、重难点、教学过程各环节、作业。

## 2 选题材主题

| 课型 | theme |
|---|---|
| 新授、听说、阅读、语法、写作 | `lecture` |
| 活动课、任务课、公开课互动环节 | `activity` |
| 复习、单元小结、试卷讲评 | `review` |

一套课件只用一个 theme，不要混用。

## 3 生成 JSON spec

`write` 工具把 spec 写成 `artifacts/<slug>.spec.json`（写文件而不是拼长命令行，避免引号事故）。格式：

```json
{
  "title": "<课题>",
  "subtitle": "<教材 · 单元 · 第 N 课时>",
  "theme": "lecture",
  "slides": [
    {"title": "学习目标", "bullets": ["能说出 5 个周末活动短语", "能用 be going to 描述计划"], "notes": "先齐读目标，再进入导入。"}
  ]
}
```

硬约束（渲染器会直接报 ValueError）：

- `slides` 1–40 项；空列表不接受。
- 每条 bullet ≤ 200 字，写短语，不写整段课文。
- `notes` 是讲稿，写给教师看：这一页怎么讲、问什么、几分钟。

内容要求：

- 8–15 页；每页 3–5 条要点。
- 第一页由渲染器自动生成封面，所以 `slides` 里不要再写封面页。
- 顺序建议：目标 → 导入 → 新授（词汇/句型/语篇分页）→ 操练 → 产出任务 → 小结 → 作业。
- 需要学生看图或填表的页，在 `notes` 里写清「此处使用课本 Pxx 图 3」，不要在 PPT 里编造图片。
- 中英混排正常写，字体由渲染器统一（Calibri / 等线），不要指定字体、字号、颜色。

## 4 渲染

在 agent 工作区根目录执行（`<slug>` 换成实际文件名，例如 `初中-英语-人教七上-U3-听说-第2课时`）：

```bash
python3 -c "import json; from agent.tools.pptx import build_deck; spec=json.load(open('artifacts/<slug>.spec.json', encoding='utf-8')); print(build_deck(spec, 'artifacts/<slug>.pptx'))"
```

- 成功时打印写入的绝对路径。
- 报 `ValueError`：按错误里指出的位置改 spec（页数超 40、bullet 超 200 字、缺 title/slides、theme 拼错），改完重跑，不要绕过渲染器直接拼 XML。

## 5 必须确认并报告

渲染后一定要验证文件真的存在、大小合理，再回报教师：

```bash
python3 -c "import os; p='artifacts/<slug>.pptx'; print(os.path.exists(p), os.path.getsize(p))"
```

回报内容：

- 文件路径：`artifacts/<slug>.pptx`（同时给出绝对路径）
- 文件大小，形如 `38.7 KB`
- 页数（`slides` 数 + 1 张封面）
- 只有 `True` 且大小 > 10 KB 才说「已生成」；否则说明失败原因，不要谎报成功。

清理：删除临时的 `artifacts/<slug>.spec.json`，除非教师要求保留。

## 6 交付

- 渠道支持直发文件时，用 `send` 工具发送这个 `.pptx`。
- 教师要求改：改 spec 对应页后整份重渲染，保持文件名稳定，便于下载链接不失效。
