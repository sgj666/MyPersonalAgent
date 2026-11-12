# 教学工具重设计 — 实施计划与接口契约（v1）

> 上游设计：`docs/plans/teaching-tools-redesign.md`（布局与理由）。
> 本文是**施工图**：契约先定死，5 个 worker 并行，各占一组互不重叠的文件。

---

## 0 已确认决策（用户 2026-11-12 答复）

| # | 决策 | 落地影响 |
|---|---|---|
| 1 | 作业卡片**图优先**（竖版群图），A4 打印附赠 | 卡片渲染器默认 `format=group`（1080×1440），`a4=true` 出打印版 |
| 2 | **不做发群**，能存图片、教师手动发 | 删除 webhook/channel 全部工作；交付条只留「保存图片 / 复制图片 / 打印」 |
| 3 | 学情背景 = 当前教师**班级 / 科目 / 教学进度 / 最近作业成绩**，自动带入；教师只补一句话 | 卡片与建议页先读 `facts`，不要求教师手填学情 |
| 4 | 课件**双出**：`.pptx` 必须，HTML 仅预览 | 一套 deck JSON → 两个渲染器（python-pptx + HTML） |
| 5 | 不接生图模型；用代码/版式做视觉 | 版式系统 + 主题 + CSS 图形；需要图时留占位并在讲稿注明课本页码 |
| 6 | 计划写入进度：**只补空，不动已授** | `overwrite=false` 语义，后端强制 |
| 7 | 历史产出按场景定：教案/课件/卡片留草稿与成品，建议/计划只留成品 | 见 §4 接口 |
| 8 | 全做；交互与样式必须好看、符合使用逻辑 | UI worker 有独立验收（截图 + 三击内完成主任务） |

**ADR-1 课件以 deck JSON 为单一源**：python 渲染 `.pptx`（交付物），HTML 模板渲染预览/导出图。否决「只做 pptx」（无法预览、改一页要整册重跑）与「只做 HTML」（教师无法二次编辑）。
**ADR-2 不用 pptxgenjs / PPTist**：前者要额外的 node 运行时（桌面端虽有，web 控制台没有），后者 AGPL-3.0 传染。python-pptx 重写 + 版式系统足够达到「像设计过」的下限。
**ADR-3 学情只读、不覆盖**：写进度只填空，已授课时一律不动（`agent/teaching/store.py` 现状语义保持）。

---

## 1 目录与文件归属（避免并行写冲突）

| 归属 | 文件/目录 |
|---|---|
| **A 渲染器**（codex） | `agent/tools/pptx/**`（重写）、`agent/teaching/render/**`（新）、`tests/test_deck_render.py`、`tests/test_card_render.py`、`tests/test_pptx_build.py`、`channel/web/api/teaching.py` 的 `TEACHING_URLS` 与 render/draft handler |
| **B 技能**（claude） | `skills/{lesson-plan,courseware-ppt,homework-card,teaching-advice,teaching-plan}/SKILL.md`、`skills/homework-summary/SKILL.md`（新）、`skills/README.md` |
| **C 洞察 API**（codex） | `agent/teaching/insights.py`（新）、`channel/web/api/teaching_insights.py`（新，含自己的 `TEACHING_INSIGHTS_URLS`）、`tests/test_teaching_insights.py` |
| **D 图片导出**（codex） | `desktop/src/main/export.ts`（新）、`desktop/src/main/index.ts`（只加注册）、`desktop/src/main/preload.ts`、`desktop/src/renderer/src/lib/exportImage.ts`（新）、`desktop/tests/` |
| **E 前端五页**（claude） | `desktop/src/renderer/src/pages/TeachingPage.tsx`、`pages/teaching/**`（新）、`components/teaching/**`（新）、`assets/clay-academics.css`（只追加 `/* teaching-tools */` 段）、`i18n.ts`（只追加 key）、`lib/menu.ts`（如需） |

**禁止**：任何人改 `channel/web/api/teaching.py` 之外的路由注册文件（`web_channel.py` 的 URLS 由协调者最后拼接一次）；B 不许改代码；D 不许改 renderer 页面；E 不许改 python。

---

## 2 契约：Deck JSON（课件单一源）

```jsonc
{
  "version": 1,
  "theme": "lecture",                  // lecture | activity | review | warm | mint
  "meta": {
    "title": "Unit 3 My weekend plan",
    "subtitle": "人教新版 七年级上 · 第 2 课时",
    "stage": "初中", "subject": "英语", "book": "人教新版",
    "unit": "Unit 3", "lesson_type": "听说", "hours": "1",
    "teacher": "李老师", "date": "2026-11-12"
  },
  "slides": [
    {"id": "s1", "layout": "cover", "title": "...", "subtitle": "...", "notes": "开场 30 秒"},
    {"id": "s2", "layout": "objectives", "title": "学习目标", "bullets": ["..."]},
    {"id": "s3", "layout": "bullets", "title": "...", "bullets": ["每条 ≤ 40 字"]},
    {"id": "s4", "layout": "two-col", "title": "...",
      "columns": [{"heading": "词汇", "bullets": []}, {"heading": "句型", "bullets": []}]},
    {"id": "s5", "layout": "compare", "title": "...",
      "columns": [{"heading": "易错", "bullets": []}, {"heading": "正确", "bullets": []}]},
    {"id": "s6", "layout": "process", "title": "...",
      "steps": [{"label": "导入", "text": "3′ 看图说话"}]},
    {"id": "s7", "layout": "timeline", "title": "...",
      "steps": [{"label": "8:00", "text": "..."}]},
    {"id": "s8", "layout": "table", "title": "...",
      "table": {"headers": ["..."], "rows": [["..."]]}},
    {"id": "s9", "layout": "image", "title": "...",
      "image": {"path": "", "caption": "课本 P32 图 3", "fit": "contain"}},
    {"id": "s10", "layout": "quote", "title": "...", "quote": "..."},
    {"id": "s11", "layout": "summary", "title": "小结与作业", "bullets": []},
    {"id": "s12", "layout": "end", "title": "谢谢"}
  ]
}
```

硬规则（渲染器校验，违反即 `ValueError` 带中文修法）：
- `slides` 1–40；`layout` 必须是上表 13 种之一；`bullets` 每条 ≤ 60 字、每页 ≤ 6 条；`process/timeline` 的 `steps` ≤ 6；`table` ≤ 6 列 × 8 行。
- 版式内文本自动排版：超出容量时**缩小字号到下限后截断并写 warning**，绝不溢出画布。
- 字体：`Calibri` + `等线`（拉丁 + 中文），不嵌字体；字号阶梯 32/24/20/16/14。
- 主题只换配色与少量装饰（色块、圆角），不改版式骨架。

## 3 契约：Card JSON（作业卡片单一源）

```jsonc
{
  "version": 1,
  "meta": {
    "class_name": "七(3)班", "class_ids": ["c_xx"], "subject": "英语",
    "stage": "初中", "book": "人教新版", "unit": "Unit 3",
    "title": "Unit 3 课后作业", "date": "2026-11-12", "due": "周四", "teacher": "李老师"
  },
  "summary": "今晚 20 分钟，重点是 be going to 的三种句型。",
  "sections": [
    {"heading": "一、词汇巩固", "tier": "basic", "hint": "每题 2 分",
     "items": [
       {"no": 1, "type": "fill", "stem": "看望祖父母 ______", "lines": 1, "answer": "visit grandparents"},
       {"no": 2, "type": "choice", "stem": "— What are you going to do?", "options": ["A. ...", "B. ..."], "answer": "B"},
       {"no": 3, "type": "short", "stem": "用 be going to 写两句话描述你的周末：", "lines": 3, "answer": ""},
       {"no": 4, "type": "read", "stem": "短文……", "lines": 4, "answer": ""}
     ]}
  ],
  "footer": {"score": true, "parent_sign": true}
}
```
规则：1–4 个 section；每 section ≤ 8 题；`type` ∈ fill|choice|short|read|match；答案只进答案版。渲染两种形态：`group`（1080×1440，群图）与 `a4`（A4 打印，`@page`）。

---

## 4 契约：HTTP 接口

全部 `_require_auth()` + agent 作用域，JSON，成功 `{"status":"success",...}`。

### 4.1 渲染（A 实现）

```
POST /api/teaching/render
{ "kind": "deck"|"card",
  "draft": {…},                       // 与 draft_path 二选一，draft 优先
  "draft_path": "artifacts/教学工具/card/…json",
  "out_name": "七3-Unit3-课后作业",     // 可选，缺省取 meta.title
  "formats": ["pptx","html"],          // card: ["html"] 或 ["html","a4"]
  "a4": false }
→ { "status":"success",
    "files": [{"format":"pptx","path":"/abs/x.pptx","rel":"artifacts/教学工具/deck/x.pptx","size":39213,"pages":12}],
    "warnings": ["第 7 页要点过多，已截断"] }
```

### 4.2 草稿（A 实现，E 使用）

```
PUT  /api/teaching/draft   {"kind":"deck"|"card","slug":"…","draft":{…}} → {"path":"artifacts/教学工具/deck/….json"}
GET  /api/teaching/draft   ?kind=deck&slug=…                              → {"draft":{…},"path":"…"}
GET  /api/teaching/drafts  ?kind=deck&limit=10                            → {"items":[{"slug","title","when","path","class_ids"}]}
```
落盘：`<workspace>/artifacts/教学工具/<kind>/<slug>.json`（`kind` ∈ deck|card|plan|advice）。

### 4.3 学情事实（C 实现，E 使用）

```
GET /api/teaching/facts?class_id=&unit=
→ {"status":"success",
   "facts":[{"key":"progress_gap","label":"教学进度","value":"落后 2 课时","detail":"计划 12，已授 10"},
            {"key":"homework_missing","label":"未交作业","value":"5 人","detail":"…"},
            {"key":"exam_weak","label":"薄弱项","value":"阅读理解 41%","detail":"…"}],
   "stats":{"students":48,"planned":12,"taught":10,"homework_missing":5,
            "exam_avg":78,"weak_skills":[{"name":"阅读理解","rate":0.41}]}}
```
数据源只用 `agent/teaching/store.py` 已有的 classes/students/progress/homework(+records)/exams/scores；缺数据时该条 `facts` 直接不返回（不要编）。

### 4.4 计划写入进度（C 实现，E 使用）

```
POST /api/teaching/progress/import
{"class_ids":["c1"],"weeks":[{"week":1,"unit":"Unit 1","topic":"听说","periods":2,"goal":"","assess":""}],
 "overwrite": false}
→ {"status":"success","created":18,"skipped":2,"conflicts":[]}
```
`overwrite` 默认 false：已存在同 `class_id+order` 的条目只补空字段（goal/assess 无处存，落 `topic` 后缀或忽略，C 自行决定并在 docstring 写明），`taught_periods>0` 的记录一律不动。

### 4.5 最近产出（C 实现，E 使用）

```
GET /api/teaching/recent?kind=deck|card|plan|advice&limit=5
→ {"status":"success","items":[{"slug","title","when","rel","kind","class_ids":[]}]}
```
读 `artifacts/教学工具/<kind>/`（草稿 JSON 优先）与 `artifacts/` 索引，按 mtime 倒序。

### 4.6 桌面导出 IPC（D 实现，E 使用）

```ts
window.desktop.exportImage({ htmlPath, width, height, selector?, outPath? })
  → { ok: true, path: "/abs/x.png", width: 1080, height: 1440 }
window.desktop.exportPdf({ htmlPath, outPath? }) → { ok: true, path: "/abs/x.pdf" }
```
实现：隐藏 `BrowserWindow`（`show:false`, `webPreferences.offline`）加载 `file://htmlPath`，等 `did-finish-load` + 字体就绪，`setContentSize(width,height)`，`webContents.capturePage()` → PNG 写盘；PDF 用 `printToPDF({pageSize:'A4'})`。失败返回 `{ok:false,error}`；`outPath` 缺省写 `artifacts/教学工具/<kind>/<slug>.png`（同目录同名）。

---

## 5 任务 DAG 与 worker 分工

```
A 渲染器 ─┬─→ E 前端五页 ─→ F 集成与打磨（协调者）
B 技能   ─┤
C 洞察   ─┤
D 导出   ─┘
```

| 任务 | 交付物 | 验收（必须给出证据） |
|---|---|---|
| **A 渲染器** | `agent/tools/pptx` 重写（13 版式 + 5 主题 + 图片/表格）、`agent/teaching/render/{deck_html.py,card_html.py,render.py}`、render/draft HTTP | `pytest tests/test_deck_render.py tests/test_card_render.py tests/test_pptx_build.py -q` 全绿；生成的 .pptx 能被 `python-pptx` 回读且页数/标题正确；HTML 无外链（`grep -c "http"` 只有注释） |
| **B 技能** | 6 个 SKILL.md 改/新 | 每个 SKILL.md 的 JSON 示例能被 `python -c "json.loads"` 解析；契约字段与 §2/§3 完全一致（脚本比对字段名） |
| **C 洞察** | `agent/teaching/insights.py`、`teaching_insights.py`、测试 | 单测覆盖：无数据→空 facts；有成绩→薄弱项排序；import 不覆盖已授 |
| **D 导出** | export.ts + preload + renderer lib + 测试 | 用真实 HTML 文件跑一次得到 PNG，`file` 报告尺寸符合入参；PDF 可打开 |
| **E 前端** | 5 页 + 5 构件 + 样式 + i18n | `npm run build` 通过；5 页各有截图；主任务（如「选班→一句话→出图」）≤ 4 次点击；空态/错误态/加载态齐全 |

**串并行**：A/B/C/D 立即并行（各自 worktree）；E 在 `current` worktree 并行开工（用 §4 契约的接口名，后端未就绪时先接 mock 并在代码里留 `// TODO(api)` 一处）；F（协调者）负责合并 4 个分支、拼 URLS 一行、跑全量测试与视觉走查。

---

## 6 环境与命令（worker 必读）

```bash
# 前端（每个新 worktree 都要）
cd desktop && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
# Python（工作区根目录）
python3 -m venv .venv && .venv/bin/pip install -q -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
# 启动桌面
cd desktop && npm run build && npx electron .
# 后端日志
tail -f /tmp/edesktop.log
```
`config.json` 已有可用自定义模型（TokenHub / deepseek-v4-pro），跑 agent 不需要再配 key。

---

## 7 视觉与交互硬要求（E 的验收口径）

1. **五页不共用一套壳**：教案=稿纸、课件=轨道+预览+讲稿、卡片=竖版手机预览、建议=事实条+清单、计划=周次表（见设计稿 §3 的 ASCII 图）。
2. **每一步都有可改的中间态**：大纲/页纲/题目清单/周次表都能改、能加、能删、能调序。
3. **空态不是空白**：每页首屏在无数据时给「怎么开始」的一句话 + 一个主按钮。
4. **交付条常驻底部**，入口文字是动词（保存图片 / 导出 pptx / 写入进度），不是「确定」。
5. 颜色/圆角/阴影只用 `--twb-*` 与 `--bg/--text/--border` 语义 token；新样式全部追加在 `clay-academics.css` 的 `/* teaching-tools */` 段内，前缀 `twt-`。
6. 中文文案进 `i18n.ts`（zh + en 两份都要），不在 tsx 里硬写中文。
7. 键盘可达：`Esc` 关弹层、`Cmd/Ctrl+Enter` 触发主操作、焦点可见。

---

## 8 派发记录（2026-11-12）

| Worker | 分支/worktree | agent | dispatch | task |
|---|---|---|---|---|
| A 渲染器 | `deck-render`（新子 worktree） | codex | `ctx_214e890e4a0a` | `task_32dcd57491ff` |
| B 技能 | `skills-v2`（新子 worktree） | claude | `ctx_d111e3cb5464` | `task_d8d8bf0ef108` |
| C 洞察 API | `insights-api`（新子 worktree） | codex | `ctx_698b3d30a5da` | `task_491a14729427` |
| D 图片导出 | `png-export`（新子 worktree） | codex | `ctx_892947f58363` | `task_132c55af2d22` |
| E 五页 UI | `current`（本 worktree） | claude | `ctx_b42c3a99758b` | `task_1aa8f4fe85a8` |

合并顺序（协调者执行）：A → C → D → B（纯文档，最后） → 拼 `TEACHING_URLS + TEACHING_INSIGHTS_URLS` 一行 → 全量 `pytest` + `npm run build` + 五页视觉走查。
