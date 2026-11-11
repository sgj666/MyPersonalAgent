# 教师 AI 工作台改造方案

| 项 | 内容 |
|---|---|
| 版本 | v2（需求已确认，未实施） |
| 日期 | 2026-11-10 |
| 仓库 | `MyPersonalAgent`（CowAgent 分支） |
| 需求来源 | 妙记《AI教师工作台功能规划》（2026-11-10 22:51–23:04）及其 AI 笔记文档 |

> 本文是实施方案，不是已完成功能说明。文中出现的文件路径均已核对过仓库现状。

---

## 1 背景与目标

### 1.1 产品定位

面向教师群体的 AI 能力工作台，服务备课、授课、作业、教研等日常教学场景。

### 1.2 技术基座

架构基座采用开源 CowAgent（本仓库），复用其对话、Skill、知识库、多渠道接入与本地部署能力，不新建框架。

### 1.3 初版范围

| 类别 | 内容 |
|---|---|
| 知识库 | 复用自带知识库，导入教材、教师手册、历史资料；按租户私有 |
| 知识库问答 | 基于已导入资料的检索问答，能回答「这个单词属于哪本教材哪个单元、使用场景、课文背景」 |
| 教学工具 | 教案生成、课件生成、作业卡片、教学建议、教学计划（均以 Skill 实现） |
| 任务跟进 | 任务看板：创建、状态更新、分列查看 |
| 基础配套 | 教师工作台主页、登录、租户隔离 |
| 客户端 | 本地安装为主；WebUI、桌面客户端；可选绑定飞书 / 微信 |

### 1.4 明确不做（初版）

- 优质课视频亮点提取与授课建议：开发成本过高，待定
- AI 生题：待后续单独立 Skill 并打磨题型体系后接入
- 家长端、校方管理端

---

## 2 已确认决策

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 主入口 | 与 CowAgent 一致：本地安装客户端 + WebUI + 可选飞书/微信 |
| 2 | 租户粒度 | 教师个人；自建账号；一账号对应一个 Agent |
| 3 | 知识库归属 | 租户私有，不共享 |
| 4 | 课件输出 | 真实 `.pptx` 文件，可下载、可经渠道直发 |
| 5 | 入口设计 | 由我方设计（本文 §4、§5） |
| 6 | 作业卡片输出 | HTML 单文件，页面内支持导出图片 |
| 7 | 教材版本 | 人教新版；知识库同时容纳教材外知识 |
| 8 | 自动化（原「定时」） | 保留，收进「设置」 |
| 9 | 日志 | 教师端不提供入口；`run.log` 照常记录 |
| 10 | 能力（skills）/ 记忆（memory） | 保留为一级入口，后续功能扩展不都进常驻菜单 |

---

## 3 总体架构

```
                ┌──────────────── 客户端 ────────────────┐
                │  WebUI  │  桌面客户端(Electron)  │ 飞书/微信 channel │
                └────────────────┬───────────────────────┘
                                 │ 同一后端 (channel/web + channel/*)
                     ┌───────────┴───────────┐
                     │   账号层（新增）        │  登录 → 会话 token → agent_id
                     └───────────┬───────────┘
                                 │ 强制作用域
                     ┌───────────┴───────────┐
                     │  Agent（= 租户）        │  一教师一 Agent
                     │  独立 workspace        │
                     └───────────┬───────────┘
        ┌──────────┬─────────────┼─────────────┬──────────┐
     knowledge   skills     会话库        board.json   artifacts
     （私有）     （私有）   （私有）      （新增）      （产出）
```

关键点：仓库已有 `AgentProfile`（`agent/registry.py`）与 `RuntimeIdentity` + `state_dir`（`common/state_dir.py`）的按 Agent 分派能力。本方案复用它作为租户隔离底座，新增的只有账号层与强制作用域。

---

## 4 信息架构（左侧菜单定稿）

```
工作台                 dashboard（新，默认首页）
任务                   board（新，看板）
教学工具  ▾            （父菜单）
   教案生成
   课件生成
   作业卡片
   教学建议
   教学计划
知识库                 knowledge（现有）
产出文件               artifacts（现默认隐藏 → 提为一级）
对话                   chat（现有）
能力                   skills（现有）
记忆                   memory（现有）
设置  ▾
   基础配置 / 模型 / 集成     config（现有 3 个 tab）
   通道绑定                  channels（现有）
   自动化                    tasks（现有「定时」，改名）
   （日志不出现）
```

### 4.1 与现有菜单的对照

仓库内置 10 个视图（`channel/web/static/js/core/nav.js` 的 `VIEW_META`、`router.js` 的 `ROUTE_PATHS`）：

| 视图 | 路由 | 现状位置 | 教师版处置 |
|---|---|---|---|
| `chat` 对话 | `/` | 对话组 | 保留（`REQUIRED_VIEWS` 之一） |
| `artifacts` 产出文件 | `/artifacts` | 对话组，默认隐藏 | 提为一级 |
| `agents` 智能体 | `/agents` | 管理 | 隐藏（一账号一 Agent，不暴露花名册） |
| `config` 配置 | `/settings` | 管理 | 保留（`REQUIRED_VIEWS` 之一），收进设置 |
| `skills` 能力 | `/skills` | 管理 | 保留为一级 |
| `memory` 记忆 | `/memory` | 管理 | 保留为一级 |
| `knowledge` 知识 | `/knowledge` | 管理 | 保留为一级 |
| `channels` 通道 | `/channels` | 管理 | 收进设置 |
| `tasks` 定时 | `/scheduler` | 管理 | 改名「自动化」，收进设置 |
| `logs` 日志 | `/logs` | 监控 | 不出现；后端日志照常 |
| `custom` 自定义项 | `/m/<id>` | 对话组 | 保留（教师可钉自己的网页/文档） |

### 4.2 实现约束

- 父菜单 = `menu.json` 的 `groups[].title`。侧栏由 `static/js/core/menu.js` 按文档渲染，后端 `channel/web/api/menu.py` 的 `clean_menu` 已支持组标题，无需改协议。
- 同一父菜单下的多个子项必须是**独立 builtin view**：`clean_menu` 的 `seen_views` 拒绝重复 view，因此教学工具有 5 个 view id，但共用一份模板与一个前端模块。
- 教师版默认菜单在首次登录时写入该租户的菜单文档，教师仍可用菜单编辑器调整。

---

## 5 页面规格

### 5.1 工作台首页（dashboard）

| 区块 | 内容 | 数据来源 |
|---|---|---|
| ① 问候条 | 问候语、日期 | 本地时间 |
| ② 指标卡 4 个 | 待办 / 进行中 / 今日截止 / 本周完成 | `board.counts` + `done_at` |
| ③ 快捷创建 5 卡 | 教案、课件、作业卡片、教学建议、教学计划 | 跳对应子页并预填 |
| ④ 任务看板迷你版 | 4 列各前 3 条、＋新建、查看全部 | `/api/tasks` |
| ⑤ 知识库动态 | 最近导入 5 份、索引状态、检索入口 | `/api/knowledge/list` |
| ⑥ 最近产出 | 最近 5 个 pptx / html / docx，可下载或预览 | `/api/artifacts` |
| ⑦ 继续上次 | 最近 3 个会话 | `/api/sessions` |
| ⑧ 今日自动化 | 今天会触发的定时任务 | `/api/scheduler` |

首页不新增后端存储，全部是既有接口的聚合读。

### 5.2 任务看板（board）

**定位边界**：「自动化」是 cron 触发的动作；「任务」是教师自己跟进的工作项。两者独立存储、独立模块，互不覆盖。

#### 5.2.1 数据模型

文件：`<agent workspace>/board.json`，原子写，带版本号。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | string | 12 位随机串 |
| `title` | string | 必填，≤120 字，空白折叠 |
| `note` | string | 可选，≤2000 字，可多行 |
| `status` | enum | `todo` / `doing` / `blocked` / `done`，四列固定顺序 |
| `lane` | string | 泳道（学科或班级），≤40 字 |
| `due` | string | `YYYY-MM-DD`，空表示无期限 |
| `due_time` | string | `HH:MM`，可空；有值时必须同时有 `due`，清空 `due` 会一并清空 |
| `category` | string | 类别，≤20 字，可空 |
| `priority` | enum | 四象限：`urgent_important` / `important` / `urgent` / `neither`；旧值写入归一（`high`→`urgent_important`、`normal`→`important`、`low`→`neither`），未知读取按 `important` |
| `source` | object | `{type: manual\|chat\|doc, ref}` |
| `created_at` / `updated_at` | string | UTC ISO |
| `done_at` | string | 仅 `done` 时有值，离开 `done` 清空 |

#### 5.2.2 接口

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/tasks?status=&lane=&sort=` | 任务列表 + 分组看板（空列也返回）；`sort=due\|priority\|created` |
| POST | `/api/tasks` | 新建任务 |
| POST | `/api/tasks/update` | 修改内容或状态 |
| POST | `/api/tasks/delete` | 删除任务 |

错误语义：字段非法 → `bad_request`；任务不存在 → `not_found`；未授权 → 401。

#### 5.2.3 交互

- 新建/编辑弹窗：标题、备注、泳道、截止日、优先级
- 列内拖动改状态；键盘可达的下拉切换作为兜底
- 泳道筛选；列内按截止日排序（无期限排最后）；逾期标红

#### 5.2.4 对话内建任务

新增 Agent 工具 `task_board`（action：`board` / `list` / `create` / `update` / `delete`），工具描述中与 `scheduler` 明确区分使用场景，使「把这周备课拆成三个任务」直接落到看板。

### 5.3 教学工具（5 个子页）

统一布局：左侧表单（学段 / 学科 / 教材版本 / 单元 / 课型 / 课时 / 目标），右侧对话区，底部「最近产出」。教师只填表单，不接触 Skill 配置。

| 子页 | 输入 | 输出与落盘位置 |
|---|---|---|
| 教案生成 | 上述表单 | markdown → `knowledge/教案/<slug>.md` |
| 课件生成 | 新建教案或选择已有教案 | `.pptx` → `artifacts/`，可下载、可经渠道直发 |
| 作业卡片 | 题目来源 + 版式 | 单文件 HTML → `artifacts/作业卡片/<slug>.html`，页内可导出图片 |
| 教学建议 | 班级情况 / 学生画像 / 课题 | 文本建议 |
| 教学计划 | 学期 / 单元范围 | 计划表（markdown 表格） |

#### 5.3.1 课件生成管线

1. Skill 产出结构化 JSON：封面、目录、每页标题 + 要点 + 备注稿
2. 本地渲染器（`python-pptx`，当前在 `requirements-optional.txt`，初版需提升到 `requirements.txt`）生成 `.pptx`
3. 落 `artifacts/`，返回路径；渠道侧用 `agent/tools/send/send.py`（已支持 `.pptx`）直接发送

质量约束：

- 3 套母版：讲授 / 活动 / 复习
- 只用主题字体，不嵌字体，避免跨机版式错乱
- 不依赖 Office、不依赖外部渲染服务，断网可用

#### 5.3.2 作业卡片 HTML 与导出图片

- 单文件自包含：内联 CSS、无外链、无网络请求，由 `artifacts` 视图内嵌预览
- 「导出图片」：本地 vendored `html2canvas`（置于 `channel/web/static/vendor/`，MIT，随包附 License），导出 PNG
- 降级路径：不支持 canvas 导出时提示「打印 → 另存为 PDF」
- 打印样式：`@media print` 隐藏按钮与页边距，屏幕与导出图版式一致
- 字体：系统字体栈（`PingFang SC` / `Microsoft YaHei` 回退），不引 webfont

### 5.4 知识库

知识库不等于教材库。顶层分「教材知识」与「教材外知识」两条主线：

```
knowledge/
├── index.md                       # 现有机制：分类总览 + 摘要，自动重建
├── log.md                         # 现有机制：变更流水
├── 教材/
│   ├── _索引.md                   # 学段/年级/册 → 单元 → 文件 汇总表
│   └── 人教新版/
│       ├── 小学/三年级上/Unit-01-....md
│       ├── 初中/七年级上/Unit-03-My-weekend-plan.md
│       ├── 初中/七年级下/...
│       └── 高中/必修一/Unit-01-....md
├── 教师手册/
│   └── 人教新版/初中/七年级上/Unit-03.md        # 与教材同构，按单元对齐
├── 评测/
│   ├── 真题/
│   └── 题库/                                    # 自建题目（AI 生题落地后并入）
├── 教研/                                        # 教学法、课标解读、公开课笔记
├── 政策与规章/                                  # 课标、教学计划要求、校内制度
└── 班级与学情/                                  # 班级档案、学生画像、家长沟通记录
```

- 页面 frontmatter 统一带 `subject / stage / grade / book / unit`
- 检索策略：先按 tags 收窄，再走向量；教材问题优先命中 `教材/人教新版/*/Unit-*.md`，避免被其他知识抢答
- 导入转换（P4）：PDF/Word 教材 → 识别单元标题 → 一单元一 md；识别不准的落到 `教材/_待整理/` 由教师手动归类，不静默乱放

### 5.5 其余入口

| 入口 | 说明 |
|---|---|
| 产出文件 | 现有 `artifacts` 视图，展示 pptx / html / docx / pdf，支持预览与下载 |
| 能力 | 现有 `skills` 视图：装卸与管理，后续新增功能不必都进常驻菜单 |
| 记忆 | 现有 `memory` 视图：教师个人 Agent 的长期记忆 |
| 设置 | `config`（3 tab）+ `channels`（渠道绑定）+ `tasks`（自动化）；日志不出现 |

---

## 6 账号与租户隔离

### 6.1 账号

- 存储：`<state_root>/users.json`，密码 scrypt 加盐
- 注册即创建 Agent（复用 `agent/admin.py` 的 Agent 管理服务），并**显式创建**该 Agent 的私有 `knowledge/`、`skills/` 目录
- 一个账号绑定一个 Agent，登录后无「切换 Agent」概念

### 6.2 会话与作用域

- Token：签名 payload `uid.agent_id.exp`，HMAC 密钥独立于 `web_password`（现状是拿口令当密钥，改密即全员掉线）
- 强制作用域：账号模式下 `_scoped_agent_id()` 忽略客户端传入的 `agent_id`，一律取会话中的值
- 兼容：无 `users.json` 时沿用现有单口令模式

### 6.3 已知风险点

`knowledge_dir()` / `skills_dir()` 在 `common/state_dir.py` 中走 `_shared_or_own`：Agent 没有私有目录时**回落到共享副本**。注册流程必须显式建目录，否则教材会串租户。

---

## 7 仓库现状与缺口

| 需求 | 现状 | 动作 |
|---|---|---|
| 知识库 | `agent/knowledge/service.py` 完整（树、导入、索引、关系图） | 复用 |
| 知识库问答 | memory 索引已具备 | 复用 |
| Skill 机制 | `agent/skills/` + `skills/`（含 `skill-creator`） | 复用，新增 5 个教学 Skill |
| 对话 | `channel/web` chat | 复用 |
| 菜单定制 | `menu.json` + `menu.js` | 复用，仅改预设 |
| 任务看板 | 无 | 新建 store + API + Agent 工具 + 视图 |
| 工作台首页 | 无 | 新建视图 |
| 教学工具子页 | 无 | 5 个轻量视图共用模板 |
| PPT 生成 | 仅能读取（`agent/tools/read/read.py` 用 python-pptx 读） | 新增渲染器 |
| 教材导入 | 仅接受文本并统一转 `.md` | 新增 PDF/Word → markdown 前置转换 |
| 登录 / 租户 | 单口令；`agent_id` 由客户端自选 | 扩展 auth + 强制作用域 |
| 渠道与 Agent 绑定 | `channel/web/api/channels.py` 已支持 | 复用 |

补充观察：工作区存在未跟踪的 `skills/slides`、`skills/design` 等目录。P3 开工前先评估 `slides` 能否复用为课件母版来源。

---

## 8 实施阶段与验收

| 阶段 | 内容 | 主要改动 | 验收 |
|---|---|---|---|
| P0 | 账号 / token / 强制作用域 / 注册建私有目录 | `common/state_dir.py`、`channel/web/api/auth.py`、`channel/web/core/_common.py`、登录页 | 两账号同机：A 传 `agent_id=B` 只能拿到 A 的数据；旧口令模式仍可登录 |
| P1 | 菜单 IA + 工作台首页 | `menu` 预设、`dashboard` 视图、`nav.js`/`router.js`/`web_channel.py` 注册 | 登录后左侧结构如 §4；首页 8 区块取真实数据 |
| P2 | 任务看板 + `task_board` 工具 | 新增 board 存储、`/api/tasks`、工具与视图 | 增删改查闭环；对话「拆分任务」落到看板 |
| P3 | 5 个教学子页 + pptx 管线 + 作业卡片导出 | 新视图 + `python-pptx` 渲染器 + vendored `html2canvas` | 课件得到可打开的 `.pptx`；卡片断网导出 PNG 且与屏幕一致 |
| P4 | 教材导入转换 + 渠道自助绑定 | `agent/knowledge/` 转换模块、导入白名单扩展 | 导入 PDF 教材后「单词→单元」可命中；教材外知识不串答 |

---

## 9 风险与边界

| 风险 | 说明 | 处置 |
|---|---|---|
| 应用层隔离 | 本地安装时所有教师数据在同一 `state_root`，同机其他进程可直接读文件 | 初版接受；登录页注明「同一设备多教师配置」；强隔离需 OS 账户或目录加密，列入后续 |
| 共享目录回落 | `_shared_or_own` 的默认行为会把教材放进共享副本 | 注册时强制建私有目录，并加测试守住 |
| 教材 PDF 质量 | 扫描版无文本层无法转换 | 初版直接报错提示，不做 OCR |
| pptx 字体差异 | 跨机缺字体导致版式错乱 | 只用主题字体、不嵌字 |
| 本地依赖 | 课件依赖 `python-pptx`；客户端打包需带入 | 依赖进入 `requirements.txt`，打包时校验 |
| 断网场景 | 本地安装常无网络 | 课件、卡片导出、知识库检索全部本地完成，不调外部渲染/图床 |

---

## 10 后续待定

- AI 生题：独立 Skill，题型体系、难度标定、题库落盘格式单独设计
- 优质课视频亮点提取：成本待评估
- 作业卡片模板库与教研共享
- 多教师协同（同学科组共享教材库）与校方管理端

---

## 11 UI 原型与外观系统

原型：`docs/plans/teacher-workbench-ui.html`（单文件，可直接双击打开）。

**视觉方向**：取样自参考站 `uupm.cc/demo/educational-platform` —— 奶油底 `#FFF9F5`、粉彩色块 `#98FF98 / #FDBCB4 / #E6E6FA / #ADD8E6`、主绿 `#22C55E`、`3px #2D3748` 深墨描边、`4px 4px 0` 硬投影、标题 Fredoka + 正文 Nunito。

**菜单（隐藏项已按决策收回）**：首页 / 对话 / 任务 / 教学工具（5 个子项）/ 知识库 / 产出文件 / 能力 / 记忆 / 设置（配置、通道、定时）。`智能体` 与 `日志` 不进入导航；日志仍照常写 `run.log`。

**外观系统**（`外观` 按钮，状态持久化）：

| 轴 | 取值 |
|---|---|
| 主题 | 糖果（默认，= 参考站）/ 海洋 / 暖阳 / 极简 |
| 明暗 | 浅色（默认，与参考站一致）/ 深色 / 跟随系统 |
| 背景 | 跟随主题 / 纸白 / 雾灰 / 米色 / 深空 / 上传图片（可选，面板保持 95% 不透明以保证文字对比） |

**对比度**：正文与粉彩色块内文字均 ≥ 8:1；主按钮沿用参考站的白字配 `#22C55E`，实测 2.1:1（低于 WCAG 4.5:1）。若要达标，把主按钮文字改为深墨 `#0B2415`（9:1），或把绿压到 `#15803D`（5.1:1）。

**已定稿的 UI 决策**（本轮确认）：

- 导航维持左侧竖向侧栏，不改顶部横条
- 中文标题使用 ZCOOL QingKe HuangYou，拉丁标题 Fredoka 700，正文 Nunito；关闭 `font-synthesis` 防止伪粗
- 主按钮保持白字配 `#22C55E`（与参考站一致，对比度 2.1:1，已知并接受）
- 默认浅色；深色、背景图与主题切换保留

**待落地**：字体需自托管（本地安装不应依赖 Google Fonts）；色板与组件 token 落到 `channel/web/static/css` 与 `themes.js`。

---

## 12 实施记录（feature/teacher-workbench）

工作树：`/Users/sgj/orca/workspaces/MyPersonalAgent/teacher-workbench`，分支 `feature/teacher-workbench`。四个后端切片 + 一个前端切片并行完成后由协调层接线。

### 12.1 已落地

| 切片 | 内容 | 关键文件 |
|---|---|---|
| P0 账号与租户 | PBKDF2-HMAC-SHA256（本机 Python 无 `hashlib.scrypt`）、HMAC token、按会话强制 `agent_id`、注册建私有 knowledge/skills、旧口令模式兼容、登录页注册入口 | `channel/web/api/account.py`、`auth.py`、`core/_common.py`、`common/state_dir.py`、登录页 |
| P1 控制台前端 | 首页 / 任务看板 / 教学工具三视图，真实 API；教学工具生成中文 prompt 并交给现有对话流 | `templates/views/{home,board,teaching}.html`、`static/js/views/*.js`、`static/css/*.css`、`core/{nav,router,menu,i18n}.js` |
| P2 任务看板 | `board.json` 存储、4 列模型、`/api/tasks*`、`task_board` Agent 工具 | `agent/board/**`、`agent/tools/task_board/**`、`channel/web/api/tasks.py` |
| P3 教学能力 | 5 个 Skill + 离线 pptx 渲染器（3 母版、16:9、不嵌字体） | `skills/{lesson-plan,courseware-ppt,card…}/**`、`agent/tools/pptx/**` |
| P4 教材导入 | PDF/Word → Markdown、扫描件显式报错、控制台白名单放宽 | `agent/knowledge/convert.py`、`service.py`、知识库视图 |

协调层负责：路由表（`/api/account/*`、`/api/tasks*`、`/home|/board|/teaching`）、外壳 include、默认浅色、看板空态四列、旧测试假 registry 签名、PDF/DOCX 上传白名单。

### 12.2 验收证据

- 切片测试：`pytest tests/test_web_account_tenant.py tests/test_task_board_*.py tests/test_pptx_builder.py tests/test_teaching_skills.py tests/test_knowledge_import_convert.py tests/test_web_console_assets.py tests/test_web_menu.py tests/test_web_console_routing.py -q` → 124 passed，1 个失败为本机子进程缺少 web.py 的既有环境问题。
- 全量 web 套件：389 passed / 12 failed，失败集合与 master 完全一致（本机环境问题：子进程无 web.py、SSE 日志捕获、等等）。
- Python 3.11（uv 环境）复验：账号/看板/pptx 切片 39 passed；全量 5588 passed，仅剩 macOS `os.waitid` 既有失败。
- 顺手修掉一个客户端可见缺陷：logout 与账号模式下的 login 拒绝不读 POST body，服务器会以 RST 关闭并让客户端丢掉响应；现在先 drain body 再返回。
- 跨切片冒烟 `scripts/teacher_smoke.py`（真实 WSGI）：注册两位教师 → 登录 → 建任务 → 跨租户隔离（B 的看板为空）→ `/home` 外壳 → 知识库导入 → 离线生成 pptx，11 项全过。
- 浏览器实测（`scripts/teacher_dev_server.py`）：`/home`、`/board`、`/teaching?tool=courseware` 渲染正常；UI 建任务后 `/api/tasks` 计数为 todo:1；教学工具提交后 `POST /message` 返回 200 且对话里出现完整提示词（模型回复因沙箱无 API Key 而报鉴权错误，属预期）。

### 12.3 桌面客户端

Electron 客户端是独立 React 界面（不是加载 Web 控制台），已同步移植三视图：

- 路由 `/home`、`/board`、`/teaching`；导航新增「教学」分组（工作台 / 任务看板 / 教学工具）
- 复用 `/api/tasks*`，看板四列常驻、拖拽与状态下拉、新建/编辑/删除、泳道筛选、逾期样式
- 教学工具生成与 Web 版逐字节一致的中文提示词，交给现有会话流：客户端是**预填输入框**（不自动发送），Web 版是直接发送——这是两端既有契约的差异，非缺陷
- 样式为新 `clay.css`，作用域限定三个页面容器；`npm run build` 通过
- 客户端 i18n 只有 zh / en，没有 zh-Hant；需要的话要单独加语言包

### 12.4 已知限制

- 真实生成（教案/课件）依赖配置模型；沙箱无 Key，只验证到「提示词送入对话」。
- 控制台侧栏维持原有深色 chrome；三个新视图使用浅色 clay 视觉，二者并列呈现。
- 控制台字体回退到 PingFang；ZCOOL QingKe HuangYou 仅存在于原型，正式包若要使用需自托管。
- 深色主题默认改为浅色，仅影响未保存偏好的新用户。
