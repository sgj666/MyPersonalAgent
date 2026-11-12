---
name: courseware-ppt
description: 由教案或表单生成课件页纲 Deck JSON（版式 + 标题 + 要点 + 图 + 讲稿），写到 artifacts/教学工具/deck/<slug>.json。Use when the teacher asks to 做课件/生成PPT/把教案做成幻灯片, or the 课件生成 page sends a lesson plan. 只产出 JSON；.pptx 与 HTML 由页面/接口渲染。
---

# 课件生成（Deck JSON）

教案 → Deck JSON → `artifacts/教学工具/deck/<slug>.json`。你的产出**只能**是这份 JSON。不要写 .pptx、HTML，不要调用任何渲染命令；渲染由页面和 `/api/teaching/render` 完成。

## 1 素材

1. 指定了教案：`read` `knowledge/教案/<文件名>.md`，取课题、目标、重难点、教学过程各环节、作业。
2. 只给了表单：缺「学段、学科、教材、单元、课型、课时」时一次问完再动手。
3. 都没给：反问单元和课型，不要凭空编一节课。

## 2 结构

顶层固定 `version: 1`、`theme`、`meta`、`slides`。`meta` 字段：`title subtitle stage subject book unit lesson_type hours teacher date`，全是字符串。

theme 按课型选，一套只用一个：

| 课型 | theme |
|---|---|
| 新授、听说、阅读、语法、写作 | `lecture` |
| 活动课、任务课、公开课互动 | `activity` |
| 复习、单元小结、试卷讲评 | `review` |
| 低年级、绘本、亲和场景 | `warm` |
| 实验、科学、清爽风格 | `mint` |

每页：`id`（s1、s2…连续）、`layout`、`title`（必填），加该版式需要的字段，`notes` 每页都写。

## 3 选版式（13 种，只能用这些）

| layout | 什么时候用 | 字段 |
|---|---|---|
| `cover` | 第一页，课题 + 教材课时 | `subtitle` |
| `agenda` | 本课流程预告，3–5 个环节名 | `bullets` |
| `objectives` | 学习目标，用学生能做到的动词 | `bullets` |
| `bullets` | 一般要点：规则、步骤、提示 | `bullets` |
| `two-col` | 两类并列内容：词汇/句型、已知/新知 | `columns`（恰好 2 栏） |
| `compare` | 易错 vs 正确、旧知 vs 新知对照 | `columns`（恰好 2 栏） |
| `process` | 教学环节、操练步骤（有先后，≤ 6 步） | `steps[{label,text}]` |
| `timeline` | 时间顺序：一天安排、故事情节、历史 | `steps[{label,text}]` |
| `table` | 词表、时间分配、评价量表（≤ 6 列 × 8 行） | `table{headers,rows}` |
| `image` | 看图说话、挂图、实验装置 | `image{path,caption,fit}` |
| `quote` | 一句核心句型、名言、产出任务指令 | `quote` |
| `summary` | 小结与作业 | `bullets` |
| `end` | 最后一页 | 只要 `title` |

## 4 硬规则

- 10–16 页；第一页 `cover`，最后一页 `end`。
- 每页要点 ≤ 6 条，每条 ≤ 40 字，写短语不写整句段落。`two-col/compare` 两栏合计 ≤ 6 条。
- `table` 每行单元格数与 `headers` 一致；单元格写短语。
- `notes` 80–200 字的教师口播稿：怎么讲、问学生什么、用几分钟。
- 需要图：`image.path` 留空字符串，`caption` 写「课本 Pxx 图 x」，`notes` 里写清用哪张图、怎么用。页码取自教案或教材文件；查不到写 `P__` 并提醒教师核对。**禁止编造图片路径。**
- 不指定字体、字号、颜色；排版由渲染器负责。

## 5 落盘与回读

1. slug：`<学段>-<学科>-<单元>-<课型>-第N课时`，去掉空格与斜杠，例如 `小学-英语-Unit3-新授-第1课时`。
2. 用 `write` 写 `artifacts/教学工具/deck/<slug>.json`，内容是纯 JSON（不要 ```、不要注释）。
3. `read` 回读，自查：能解析、页数 10–16、layout 都在上表、每条要点 ≤ 40 字。
4. 回报：路径、页数、theme、哪几页需要教师补图（列页码与 caption）。

## 6 完整示例（12 页）

```json
{"version": 1, "theme": "lecture",
 "meta": {"title": "Unit 3 My weekend plan", "subtitle": "人教PEP 六年级上 · Part A Let's learn", "stage": "小学", "subject": "英语", "book": "人教PEP 六年级上", "unit": "Unit 3", "lesson_type": "新授", "hours": "1", "teacher": "李老师", "date": "2026-11-12"},
 "slides": [
  {"id": "s1", "layout": "cover", "title": "Unit 3 My weekend plan", "subtitle": "Part A Let's learn · 第 1 课时", "notes": "上课问候后直接展示封面，用中文说明本节课要学会说自己的周末计划。快速问两三个学生：What did you do last weekend? 只听不纠错，引出本课主题。用时约 1 分钟，不展开讲解。"},
  {"id": "s2", "layout": "agenda", "title": "今天我们这样学", "bullets": ["看图说短语", "学句型 be going to", "两人问答练习", "说说我的周末"], "notes": "用 30 秒带学生读一遍四个环节，告诉他们每完成一个环节就在板书上打勾。这样学生知道节奏，后面的小组活动更容易收住。不要在这页停留太久，读完直接进入目标页，并提醒学生准备好课本。"},
  {"id": "s3", "layout": "objectives", "title": "学习目标", "bullets": ["看图说出 4 个周末活动短语", "听懂并会读 6 个时间词", "能用 be going to 问答周末计划"], "notes": "请一名学生读目标，教师把关键词 visit、see、take、go 圈出来。告诉学生下课前会请三个人用今天的句型说自己的计划，作为检查标准。整页用时约 1 分钟。"},
  {"id": "s4", "layout": "image", "title": "Look and say", "image": {"path": "", "caption": "课本 P__ Let's learn 挂图", "fit": "contain"}, "notes": "此处使用课本 Let's learn 挂图，页码请教师按手中教材核对。先遮住短语，只让学生看图猜人物在做什么，用中文说也可以。再逐个揭开短语，带读三遍。问：Who is going to see a film? 用时约 4 分钟。"},
  {"id": "s5", "layout": "table", "title": "周末活动短语", "table": {"headers": ["短语", "中文", "动作提示"], "rows": [["visit my grandparents", "看望祖父母", "挥手敲门"], ["see a film", "看电影", "双手比画屏幕"], ["take a trip", "去旅行", "背包走路"], ["go to the supermarket", "去超市", "推购物车"]]}, "notes": "带读每个短语，配合动作提示做 TPR：教师说短语，学生做动作；再反过来，教师做动作学生说短语。注意 grandparents 的重音和 supermarket 的连读。全班两轮后抽三名学生单独说，用时约 4 分钟。"},
  {"id": "s6", "layout": "two-col", "title": "时间词与句型", "columns": [{"heading": "时间词", "bullets": ["this morning / afternoon", "this evening / tonight", "tomorrow / next week"]}, {"heading": "句型", "bullets": ["What are you going to do?", "I'm going to see a film.", "When are you going to go?"]}], "notes": "左栏时间词先按一天的顺序排，让学生发现 this 加上午下午晚上的规律。右栏句型用教师自己的周末做示范，例如 I'm going to visit my grandparents tomorrow. 请学生跟读并替换短语，用时约 5 分钟。"},
  {"id": "s7", "layout": "compare", "title": "这样说不对", "columns": [{"heading": "易错", "bullets": ["I going to see a film.", "He are going to take a trip.", "I'm going to visits my grandparents."]}, {"heading": "正确", "bullets": ["I'm going to see a film.", "He is going to take a trip.", "I'm going to visit my grandparents."]}], "notes": "先只显示左栏，让学生找错并说理由，再揭示右栏。强调三点：be 不能丢、be 随主语变、to 后面用动词原形。可以让学生用手势表示 am、is、are。这一页是本课难点，给足 4 分钟。"},
  {"id": "s8", "layout": "process", "title": "两人问答", "steps": [{"label": "听", "text": "听录音，圈出时间词"}, {"label": "问", "text": "A 问 What are you going to do?"}, {"label": "答", "text": "B 用短语和时间词回答"}, {"label": "换", "text": "交换角色再说一轮"}], "notes": "先请一组学生上台示范一轮，教师站在旁边提示时间词。然后全班同桌两人一组练习，教师巡视，记录两个说得好的组和一个典型错误。计时 5 分钟，结束前提醒交换角色，最后请记录到的好组再展示一次。"},
  {"id": "s9", "layout": "timeline", "title": "Sarah 的周末", "steps": [{"label": "Sat 上午", "text": "go to the supermarket"}, {"label": "Sat 下午", "text": "see a film"}, {"label": "Sun 上午", "text": "visit her grandparents"}, {"label": "Sun 晚上", "text": "do her homework"}], "notes": "用时间轴复述 Sarah 的周末，教师指一格学生说一句：She is going to see a film on Saturday afternoon. 注意主语换成 she 后用 is。最后让学生合上书按顺序说出两条，用时约 4 分钟。"},
  {"id": "s10", "layout": "quote", "title": "说说我的周末", "quote": "This weekend, I'm going to ___. I'm going to ___ on Sunday.", "notes": "给学生 1 分钟准备，可以在练习本上写关键词，不写整句。然后请三名不同层次的学生上台说，其他同学听完用 Who is going to see a film? 这类问题追问。这一步对应目标三，用时约 5 分钟。"},
  {"id": "s11", "layout": "summary", "title": "小结与作业", "bullets": ["4 个短语 + 6 个时间词", "be going to + 动词原形", "基础：短语抄写 2 遍", "提升：写 3 句我的周末计划"], "notes": "请学生齐读小结两行，教师指着板书打勾，回顾四个环节都完成了。布置分层作业：基础题全班必做，提升题自选。提醒家长签字栏在作业卡片上，周四收作业，用时约 2 分钟。"},
  {"id": "s12", "layout": "end", "title": "Have a nice weekend!", "notes": "下课前用 Have a nice weekend! 和学生道别，学生回应 You too。如果还有时间，可以随机问一名学生 What are you going to do tonight? 作为结束。整页不超过 30 秒。"}
 ]}
```

## 7 常见错误

- 要点写成整段课文或长句：一条超过 40 字就拆条或改短语。
- 页数超：超过 16 页就合并操练页；少于 10 页说明环节漏了。
- 版式乱用：全部用 `bullets`；对照内容不用 `compare`；时间顺序用了 `process`；表格内容硬塞进要点。
- `two-col/compare` 写成 3 栏，或两栏合计超过 6 条。
- `notes` 空着、只写「讲解」，或复述页面文字。
- 编造 `image.path`，或 caption 里写了教材里没有的图。
- 输出里夹解释文字、``` 或 `//` 注释，导致 JSON 解析失败。
