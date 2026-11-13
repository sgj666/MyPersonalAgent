---
name: courseware-ppt
description: 由教案或口述生成可编辑的 .pptx 课件。Use when the teacher asks to 做课件/生成PPT/把教案做成幻灯片, or chooses 新建教案 / 已有教案 on the 课件生成 page. 走内置的 ppt-master 技能（skills/ppt-master）：先写每页 SVG，再由 svg_to_pptx 转成原生 PPTX，写到 artifacts/教学工具/deck/<slug>/。
---

# 课件生成（ppt-master Quick 路由）

**底层是内置的 `ppt-master` 技能**（MIT，vendored 在 `skills/ppt-master/`，版本见其 `SKILL.md` 的 metadata）。它把 SVG 转成**原生 DrawingML 形状**——教师在 PowerPoint 里能改字、改色、挪框，不是一张图片。

你只做两件事：**写页纲**、**逐页写 SVG**。渲染（SVG → pptx）由页面调用后端完成，你不跑导出命令。

## 1 先读技能文档（按这个顺序，别跳）

1. `${SKILL_DIR}/workflows/profiles/quick-generate.md` — 你要走的路由，规则全在这。
2. `${SKILL_DIR}/references/shared-standards-core.md` — 版式、字号、留白的硬标准。
3. `${SKILL_DIR}/references/executor-base.md` — 页面的执行与自检口径。
4. `${SKILL_DIR}/references/semantic-svg.md` — 哪些 SVG 写法会被识别成什么形状。
5. `${SKILL_DIR}/references/preset-shape-vocabulary.md` — 可用的预设形状词表（第一页之前通读）。

`SKILL_DIR` = `skills/ppt-master/` 的**绝对路径**（用 `bash` pwd 确认，不要猜）。

## 2 收素材

按顺序找：教师指定的教案（`knowledge/教案/<文件名>.md`）→ 表单/口述 → 都没有就先反问单元与课型，不要凭空编一节课。

从教案取：课题、目标、重难点、教学过程各环节、作业。

## 3 定画布与字体（硬约束）

- 画布固定 **1280×720**：每一页根元素必须是 `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" lang="zh-CN">`。画布不一致导出会拒绝。
- 字体用 PPT 安全字：中文 `PingFang SC` / `Microsoft YaHei`，拉丁 `Arial`。**不引 webfont、不写 `@import`**。
- 颜色用大写 `#RRGGBB`；需要透明用 `fill-opacity`，不要 8 位 hex。
- 文本换行用 `<text>` + `<tspan>`，**禁止 `foreignObject`**（导出不支持）。

## 4 页数与节奏

- 10–16 页（教师给的页数为准，±2 页内）。
- 顺序：封面 → 目标 → 导入 → 新授（词汇/句型/语篇分开）→ 操练 → 产出 → 小结与作业 → 结束页。
- 每页一个主张：标题 + 3–5 个要点，或一张对照/流程/表格。不要一页塞两件事。
- 讲稿写进每页的 `notes`（80–200 字，写"这页怎么讲、问什么、几分钟"），导出时会进 PowerPoint 备注。

## 5 主题

`lecture`（新授/听说/阅读/语法/写作）、`activity`（活动/公开课）、`review`（复习/讲评）。一套课件只用一个主题，配色与标题装饰跟着主题走，版式骨架不变。

## 6 产出与落盘

目录：`artifacts/教学工具/deck/<slug>/`（`<slug>` = `<学段>-<学科>-<单元>-<课型>`，去掉空格斜杠）。

1. **页纲**：`artifacts/教学工具/deck/<slug>/outline.md`，一行一页：`01 | 封面 | Unit 3 My weekend plan`，供教师确认顺序。
2. **页面**：`artifacts/教学工具/deck/<slug>/svg_output/01_cover.svg` …（零填充两位，名字用英文或拼音，别用空格）。
3. **草稿 JSON**：`artifacts/教学工具/deck/<slug>.json`，把每页的 `svg_path` 指给页面，前端据此预览与单页重画：

```json
{"version": 1,
 "meta": {"title": "Unit 3 My weekend plan", "subtitle": "人教新版 七年级上 · 第 2 课时",
          "stage": "初中", "subject": "英语", "book": "人教新版", "unit": "Unit 3",
          "lesson_type": "听说", "hours": "1", "teacher": "李老师", "date": "2026-11-12"},
 "slides": [
   {"title": "封面", "svg_path": "artifacts/教学工具/deck/初中-英语-U3-听说/svg_output/01_cover.svg", "notes": "开场 30 秒，点题。"},
   {"title": "学习目标", "svg_path": "artifacts/教学工具/deck/初中-英语-U3-听说/svg_output/02_objectives.svg", "notes": "齐读目标。"}
 ]}
```

4. **讲稿**（可选）：同目录 `notes/01_cover.md`，与 SVG 同名，导出时自动配到对应页。

## 7 写完必须自查（否则导出会被拒）

```bash
python3 "skills/ppt-master/scripts/svg_quality_checker.py" "<项目目录>" \
  --quick-generate --canonical-authoring --stage final --json
```

- 项目目录 = `artifacts/教学工具/deck/<slug>/`，里面要有 `svg_output/`。
- 报告 `validation/svg_quality_report.json` 出现 blocking error 就按提示改页面，**不要绕过**。
- 常见拒绝原因：viewBox 不是 1280×720、`foreignObject`、文本溢出边框、字体不是 PPT 安全字、图片缺失。

## 8 报告给教师

- 页数、每页标题、文件路径（`artifacts/教学工具/deck/<slug>/`）。
- 说明交付物是可编辑 `.pptx`（由后端导出），SVG 只是中间稿。
- 需要改：改对应页的 SVG 后重跑自检，再让页面重新导出；**保持文件名稳定**，便于替换。

## 9 禁止（怎么算失败）

- 直接写 `.pptx`（XML/二进制），或用 python-pptx 手搓幻灯片 —— 交付走 ppt-master 导出。
- 引入 webfont / CDN / 外链图片；断网必须能渲染。
- 画布不是 1280×720，或混用不同画布。
- 编造教材页码、编造配图路径。
- 输出里夹解释文字，导致草稿 JSON 解析失败。
