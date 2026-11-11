# 教学工作台（第二期）：班级 / 课表 / 进度 / 作业 / 成绩

> 目标：把任课老师每天真实的五件事做成结构化数据与页面，而不是通用看板。
> 不复制参考项目（workstation-subject-teacher，非商业许可）的代码与文案；只借鉴其「按真实流程组织」的思路。

## 1 菜单（与原有 CowAgent 结构对齐）

原有三组保持顺序：对话 → 管理 → 监控。新增加一组「教学」，插在对话之后，不折叠（组头无 chevron，常开）：

```
对话     对话 · 产出文件
教学     工作台 · 班级与学生 · 课表 · 教学进度 · 作业 · 成绩 · 任务看板 · 教学工具 · 知识
管理     智能体 · 配置 · 能力 · 记忆 · 通道 · 定时
监控     日志
```

- 菜单组不可折叠；侧栏本身仍可收起（工具条保留）
- 图标统一 lucide 线性 18px；组内按「日常高频 → 低频」排序
- 桌面端与 Web 端同一份 IA、同一套命名

## 2 数据模型（每租户 workspace 下 `teaching/`，原子写 + 文件锁）

| 文件 | 结构 |
|---|---|
| `classes.json` | `{version, classes:[{id,name,grade,subject,room,created_at}]}` |
| `students.json` | `{students:[{id,class_id,no,name,gender,tags[],note}]}`（同学号唯一，重名靠学号区分） |
| `timetable.json` | `{periods:[{index,start,end}], slots:[{id,class_id,weekday,period,subject,kind}], overrides:[{date,period,class_id,subject,kind,state:changed\|cancelled}]}` |
| `progress.json` | `{items:[{id,class_id,topic,planned_periods,taught_periods,order,updated_at}]}` |
| `homework.json` | `{items:[{id,class_ids[],title,kind,due,created_at}], records:{hw_id:{student_id: state}}}`，state=`submitted\|excellent\|fix\|missing` |
| `exams.json` | `{exams:[{id,name,date,class_ids[],subject,full_score,items:[{key,label,full}]}]}` |
| `scores.json` | `{by_exam:{exam_id:{student_id:{total,items:{key:value\|null}}}}}`，缺考=null |

## 3 API（新前缀 `/api/teaching/*`，全部 `_require_auth` + 会话 agent 作用域）

- `GET/POST/PATCH/DELETE /api/teaching/classes`
- `GET/POST /api/teaching/students`（GET 带 `class_id`；POST 支持批量 `students[]` 粘贴导入，按学号 upsert）
- `PATCH/DELETE /api/teaching/students/<id>`
- `GET/PUT /api/teaching/timetable`（整表读写，含 periods/slots/overrides）
- `GET/POST/PATCH/DELETE /api/teaching/progress`
- `GET/POST/PATCH/DELETE /api/teaching/homework`；`PUT /api/teaching/homework/<id>/records`（整块状态）
- `GET/POST/PATCH/DELETE /api/teaching/exams`
- `PUT /api/teaching/scores/<exam_id>`（整班整块提交，服务端校验满分与缺考）
- `GET /api/teaching/analysis?exam_id=&class_id=` → `{summary, by_class[], items[], critical[], students[]}`

错误统一 `{"status":"error","code":"bad_request|not_found","message":...}`。

## 4 页面

1. **班级与学生**：左侧班级列表（新建/重命名/删除），右侧花名册；表头排序、搜索；「粘贴导入」解析 Excel 复制的多行（识别 姓名/学号/性别/标签/备注 表头，无表头按 学号,姓名 兜底），预览后再落库。
2. **课表**：周一至周五 × 节次的网格，点格选择班级与类型（正课/早读/辅导/晚自习/课后服务/教研/值班）；一次调课或停课不改固定表；右侧课时统计；打印样式。
3. **教学进度**：按班级展示课题清单（课题、计划课时、已讲课时），「讲完了」推进一节；自动算快/慢；可从教学计划整段粘贴。
4. **作业**：一次布置给多个班，截止日默认该班下一次上课；逐人状态；「其余都已交」；一键复制未交名单；上交率。
5. **成绩**：新建考试（班级、满分、可选分项）；表格录入（回车下移、方向键、整块粘贴）；缺考；分析页：平均分/及格率/优秀率/标准差、平行班对比、分项得分率、临界生、学生历次趋势。

## 5 验收

- 后端：`tests/test_teaching_*` 覆盖存储、校验、跨租户、统计口径（缺考不计入、分项满分校验、平行班对比）。
- 前端：`npm run build`（桌面）/ 控制台资产测试（Web）；真实服务冒烟：建班 → 导入 10 名学生 → 排一节课 → 记一次作业 → 建一次考试录分 → 分析返回合理数字。
- 菜单：两组客户端均按 §1 渲染，组不可折叠。

---

## 6 实施记录（第二期）

### 6.1 已落地

- **数据层** `agent/teaching/`：7 个 JSON（classes/students/timetable/progress/homework/exams/scores），原子写 + 文件锁，租户隔离；删除班级级联清理学生、课表槽位、进度、作业与考试
- **分析** `analysis.py`：及格 60% / 优秀 85% / 低分 40%，缺考不计；班级与分项得分率、临界生（线下方 5 分带）、平行班、同科历次趋势
- **接口** `/api/teaching/*` 共 10 条，已扁平化并入 `web.py URLS`（注意：web.py 只接受扁平 pattern/handler 对）
- **Web 控制台**：班级与学生 / 课表 / 教学进度 / 作业 / 成绩 五个视图，真实接口；菜单按 §1 重排且**组不可折叠**；非聊天视图不再显示历史会话栏
- **桌面客户端**：同样五页（React），路由 `/classes` `/timetable` `/progress` `/homework` `/scores`，菜单同 IA；`npm run build` 通过

### 6.2 验收

- `tests/test_teaching_store|api|analysis.py` → 24 passed
- `scripts/teacher_smoke.py` → 21 项全过（新增：建班 → 导入 10 人 → 写课表 → 作业+逐人状态 → 建考试（分项）→ 整班录分 → 分析）
- Web 控制台：`test_web_console_assets/routing/menu` 41 passed（唯一失败为既有的子进程缺 web.py）
- 桌面：renderer+main 构建通过；`tsc --noEmit` 仅剩 9 个既有 ChannelsPage 类型报错
- 浏览器/CDP 实测：`/classes`、`/timetable` 等页面渲染，菜单分组与顺序正确，侧栏无折叠箭头

### 6.3 说明

- 桌面端 i18n 仅 zh/en（无繁体）；教学工具在桌面端为「预填输入框」，Web 端为直接发送
- 演示用的测试班级/考试已从 `~/cow` 真实工作区清理

---

## 7 今日课程与提醒（第三期）

### 7.1 数据

- `timetable.slots[]` 增加 `mine: bool`（默认 true）与可选 `teacher`：同一张课表既能表示「我的课」，也能承载班级全科课表；非我的课仅展示、不触发提醒。
- 新增 `teaching/settings.json`：
  `{ "morning": {"enabled": true, "time": "07:30"}, "lesson": {"enabled": true, "minutes": 10}, "channel": "web" }`

### 7.2 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/teaching/today?date=YYYY-MM-DD` | 今日我的课（含讲课课题）、今日到期任务、今日作业、`digest_text` |
| GET/PUT | `/api/teaching/settings` | 简报与课前提醒设置 |
| POST | `/api/teaching/reminders/sync` | 按当前课表与设置重排调度任务（幂等，先删旧标签订单再建） |
| GET | `/api/teaching/reminders/preview` | 返回 `digest` 与下一条 `lesson` 提醒文案，供 UI 预览 |

### 7.3 调度与文案

- **早晨简报**：每日 `morning.time`（默认 07:30），`ai_task=true`，提示词携带日期与「用教学工具汇总今天课程与待办干成一条消息」；无课程时只报待办。
- **课前提醒**：每个 `mine=true` 的槽位生成一条 cron（`minutes` 分钟前，默认 10），固定文案：

  简报：
  ```
  早上好，孙老师。今天周二，3 节课：
  · 08:00–08:40 七（1）班 英语（Unit 3 My weekend plan）
  · 10:00–10:40 七（2）班 英语
  今日待办 2 项：批改周测（今天截止）、Unit 3 课件
  作业未交 2 人：张三、李四
  ```

  课前：
  ```
  ⏰ 10 分钟后上课：第 3 节 10:00 七（1）班 · 英语
  今天讲「Unit 3 My weekend plan」；作业：Unit 3 词汇练习
  ```
- 课表或设置变更后自动 `sync`；任务名统一前缀 `[teaching]` 便于幂等清理；投递走 scheduler 现有 recipient（Web 默认，绑定飞书/微信时同发）。

### 7.4 UI

- 工作台：新增「今日课程」卡（我的课标绿点，点击进课表）、「今日简报」卡（显示 `digest_text`，可复制）、「提醒设置」入口（开关 + 时间 + 提前分钟）。
- 课表：格子显示是否我的课；工具条加「只看我的课」；编辑弹窗加「这是我的课」。
- 课前提醒与简报均可在设置里关闭。
