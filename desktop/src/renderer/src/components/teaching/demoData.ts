// Illustrative data for `?demo=1` only — screenshots and visual review while
// the backend endpoints are still being built. Never used by default: the
// pages read the real API and show an error state when it is missing.
import type { TeachingFacts, TeachingRecentItem, TeachingWeek } from '../../api/client'
import type { KnowledgeList, ProgressItem, TeachingClass, TeachingTimetable } from '../../types'
import type { AdviceAction, CardDraft, DeckDraft, OutlineRow } from '../../pages/teaching/drafts'

export const DEMO_CLASSES: TeachingClass[] = [
  { id: 'c3', name: '七(3)班', grade: '七年级', subject: '英语', room: '301', created_at: '' },
  { id: 'c4', name: '七(4)班', grade: '七年级', subject: '英语', room: '302', created_at: '' },
  { id: 'c5', name: '七(5)班', grade: '七年级', subject: '英语', room: '303', created_at: '' },
]

export const DEMO_KNOWLEDGE: KnowledgeList = {
  enabled: true,
  stats: { pages: 9, size: 48000 },
  tree: [
    {
      dir: '教材',
      files: [],
      children: [
        {
          dir: '人教新版七上',
          files: [
            { name: 'Unit 3 My weekend plan.md', title: 'Unit 3 My weekend plan', size: 5200 },
            { name: 'Unit 4 My day.md', title: 'Unit 4 My day', size: 4800 },
          ],
          children: [],
        },
      ],
    },
    { dir: '课标', files: [{ name: '英语课程标准-三级.md', title: '英语课程标准（三级）', size: 9000 }], children: [] },
    { dir: '教案', files: [{ name: '初中-英语-Unit 2-读写课.md', title: 'Unit 2 读写课教案', size: 6100 }], children: [] },
  ],
}

export const DEMO_RECENT: TeachingRecentItem[] = [
  { slug: 'u2-read', title: 'Unit 2 读写课教案', when: '2026-11-05', rel: 'artifacts/教学工具/plan/u2-read.json', kind: 'plan', class_ids: ['c3'] },
  { slug: 'u2-card', title: '七(3) Unit 2 作业反馈', when: '2026-11-07', rel: 'artifacts/教学工具/card/u2-card.json', kind: 'card', class_ids: ['c3'] },
]

export const DEMO_FACTS: TeachingFacts = {
  facts: [
    { key: 'progress_gap', label: '教学进度', value: '落后 2 课时', detail: '计划 12 课时，已授 10 课时（Unit 3 第 2 课时未上）' },
    { key: 'homework_missing', label: '未交作业', value: '5 人', detail: '近两次作业：王一、李二、张三、赵四、钱五' },
    { key: 'exam_weak', label: '薄弱项', value: '阅读理解 41%', detail: '10 月单元测阅读题得分率 41%，全年级 56%' },
    { key: 'exam_avg', label: '单元测均分', value: '78', detail: '满分 100，及格率 86%' },
  ],
  stats: { students: 48, planned: 12, taught: 10, homework_missing: 5, exam_avg: 78 },
}

export const DEMO_OUTLINE: OutlineRow[] = [
  { id: 'o1', title: '教学目标', point: '能用 be going to 说出周末计划；读懂对话并复述', time: '随堂' },
  { id: 'o2', title: '重难点', point: '重点 be going to 句型；难点 be 动词随主语变化', time: '随堂' },
  { id: 'o3', title: '教学准备', point: '短语卡 6 张、课文录音、周末计划表', time: '课前 10′' },
  { id: 'o4', title: '教学过程', point: '导入 5′→新授 15′→操练 13′→产出 8′→小结 4′', time: '45′' },
  { id: 'o5', title: '板书设计', point: '左栏短语、右栏问答句型、下方时间词', time: '随堂' },
  { id: 'o6', title: '作业布置', point: '基础：抄写短语；提升：写 3 句周末计划', time: '课后 15′' },
  { id: 'o7', title: '教学反思', point: '目标达成证据 / 学生卡点 / 下次改什么', time: '课后 5′' },
]

export const DEMO_PLAN_MD = `# Unit 3 My weekend plan（读写课）

| 项 | 内容 |
|---|---|
| 学段 / 学科 | 初中 / 英语 |
| 教材 / 单元 | 人教新版 七年级上 / Unit 3 |

## 1 教学目标
- 能在图片提示下说出 6 个周末活动短语；
- 能用 *be going to* 询问并回答周末计划。

## 2 重难点
**重点**：be going to 的肯定、否定与一般疑问句。**难点**：be 动词随主语变化。

## 4 教学过程
| 环节 | 时长 | 教师活动 | 学生活动 |
|---|---|---|---|
| 导入 | 5′ | 展示周末照片提问 | 看图说话 |
| 新授 | 15′ | 呈现句型、领读 | 跟读、替换练习 |
`

export const DEMO_DECK: DeckDraft = {
  version: 1,
  theme: 'lecture',
  meta: { title: 'Unit 3 My weekend plan', subtitle: '人教新版 七年级上 · 第 2 课时', unit: 'Unit 3', teacher: '李老师' },
  slides: [
    { id: 's1', layout: 'cover', title: 'Unit 3 My weekend plan', subtitle: '七年级上 · 读写课', notes: '开场 30 秒：问学生上周末做了什么，引出“计划”这个词。' },
    { id: 's2', layout: 'objectives', title: '学习目标', bullets: ['说出 6 个周末活动短语', '用 be going to 问答计划', '读懂对话并复述'], notes: '逐条读目标，请学生在课末自评是否达成。' },
    { id: 's3', layout: 'two-col', title: '词汇与句型', columns: [{ heading: '词汇', bullets: ['visit grandparents', 'see a film'] }, { heading: '句型', bullets: ['What are you going to do?', "I'm going to ..."] }], notes: '左边词汇先领读两遍，右边句型做替换练习。' },
    { id: 's4', layout: 'process', title: '课堂流程', steps: [{ label: '导入', text: '5′ 看图说话' }, { label: '新授', text: '15′ 句型呈现' }, { label: '操练', text: '13′ 两人问答' }], notes: '' },
    { id: 's5', layout: 'summary', title: '小结与作业', bullets: ['抄写短语 2 遍', '写 3 句周末计划'], notes: '布置作业时说明预计用时 15 分钟。' },
  ],
}

export const DEMO_CARD: CardDraft = {
  version: 1,
  meta: { class_name: '七(3)班', class_ids: ['c3'], subject: '英语', stage: '初中', book: '人教新版', unit: 'Unit 3', title: 'Unit 3 课后作业', date: '2026-11-12', due: '周四', teacher: '李老师' },
  summary: '今晚 20 分钟，重点是 be going to 的三种句型。',
  sections: [
    { heading: '一、基础巩固', tier: 'basic', hint: '每题 2 分', items: [
      { no: 1, type: 'fill', stem: '看望祖父母 ______', lines: 1, answer: 'visit grandparents' },
      { no: 2, type: 'choice', stem: '— What are you going to do?', options: ['A. I go swimming.', "B. I'm going to swim."], answer: 'B' },
    ] },
    { heading: '二、能力提升', tier: 'advanced', items: [
      { no: 3, type: 'short', stem: '用 be going to 写两句话描述你的周末：', lines: 3, answer: '' },
    ] },
    { heading: '三、拓展挑战', tier: 'challenge', items: [
      { no: 4, type: 'read', stem: '阅读短文，回答 Tom 周六的计划。', lines: 3, answer: '' },
    ] },
  ],
  footer: { score: true },
}

export const DEMO_ACTIONS: AdviceAction[] = [
  { id: 'a1', title: '阅读题是主因：明早 10 分钟限时读', when: '明天早读', owner: '我', steps: ['材料取 Unit 3 第二篇', '限时 6 分钟读 + 4 分钟核对'], expected: '两周后阅读得分率回到 55%' },
  { id: 'a2', title: '5 人连续未交：课代表一对一', when: '今天放学前', owner: '课代表', steps: ['列名单交给课代表', '当面确认原因并登记'], expected: '本周未交人数降到 2 人以内' },
]

export const DEMO_WEEKS: TeachingWeek[] = [
  { week: 1, unit: 'Starter', topic: '字母与问候', periods: 4, goal: '能用英语打招呼', assess: '口头' },
  { week: 2, unit: 'Unit 1', topic: '听说', periods: 5, goal: '介绍自己', assess: '对话' },
  { week: 3, unit: 'Unit 1', topic: '读写', periods: 5, goal: '读懂名片', assess: '小测' },
  { week: 4, unit: 'Unit 2', topic: '听说', periods: 5, goal: '介绍家人', assess: '对话' },
  { week: 5, unit: 'Unit 2', topic: '读写', periods: 6, goal: '写家庭介绍', assess: '作文' },
  { week: 6, unit: 'Unit 3', topic: '听说', periods: 5, goal: '谈周末计划', assess: '对话' },
]

export const DEMO_TIMETABLE: TeachingTimetable = {
  periods: [],
  slots: [1, 2, 3, 4].map((weekday) => ({ id: `t${weekday}`, class_id: 'c3', weekday, period: 2, subject: '英语', kind: 'regular' as const, mine: true })),
  overrides: [],
}

export const DEMO_PROGRESS: ProgressItem[] = [
  { id: 'p1', class_id: 'c3', topic: 'Starter 字母与问候', planned_periods: 4, taught_periods: 4, order: 1, updated_at: '' },
  { id: 'p2', class_id: 'c3', topic: 'Unit 1 听说', planned_periods: 5, taught_periods: 2, order: 2, updated_at: '' },
]

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c)

/** A stand-in deck preview (one `section.slide` per page), mirroring the renderer's markup. */
export function demoDeckHtml(deck: DeckDraft): string {
  const slides = deck.slides
    .map((slide, i) => {
      const bullets = [
        ...(slide.bullets || []),
        ...(slide.columns || []).map((c) => `${c.heading}：${c.bullets.join(' · ')}`),
        ...(slide.steps || []).map((s) => `${s.label} — ${s.text}`),
      ]
      return `<section class="slide" data-slide="${i + 1}" data-layout="${slide.layout}"><span class="tag">${esc(slide.layout)}</span><h1>${esc(slide.title)}</h1>${slide.subtitle ? `<p class="sub">${esc(slide.subtitle)}</p>` : ''}<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul><span class="no">${i + 1}</span></section>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#f4efe9}.slide{box-sizing:border-box;width:1920px;height:1080px;padding:120px 160px;background:linear-gradient(135deg,#fffaf5,#e8f4ec);font-family:-apple-system,"PingFang SC",sans-serif;color:#3b3546;position:relative}.slide h1{font-size:88px;margin:40px 0 24px}.sub{font-size:44px;color:#6e6579}.slide ul{font-size:48px;line-height:1.7}.tag{font-size:28px;background:#d6f1e2;color:#1f5a3d;border-radius:20px;padding:6px 20px}.no{position:absolute;right:80px;bottom:60px;font-size:32px;color:#948c9c}</style></head><body>${slides}</body></html>`
}

/** A stand-in 1080×1440 card preview. */
export function demoCardHtml(card: CardDraft, answer: boolean): string {
  const sections = card.sections
    .map((sec) => `<h2><span class="tier ${sec.tier}">${esc(sec.heading)}</span></h2>${sec.items.map((item) => `<div class="q"><b>${item.no}.</b> ${esc(item.stem)}${(item.options || []).map((o) => `<div class="opt">${esc(o)}</div>`).join('')}${answer && item.answer ? `<div class="ans">答案：${esc(item.answer)}</div>` : '<div class="line"></div>'}</div>`).join('')}`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{width:1080px;height:1440px;box-sizing:border-box;padding:72px;background:#fffaf5;font-family:-apple-system,"PingFang SC",sans-serif;color:#3b3546;font-size:34px}header{background:#dcf3e6;border-radius:36px;padding:40px 48px;margin-bottom:36px}header h1{margin:0 0 8px;font-size:60px}header p{margin:0;color:#6e6579}.tier{font-size:30px;border-radius:30px;padding:8px 24px;background:#e1eee4}.advanced{background:#fff0d2}.challenge{background:#f4dfe8}.q{margin:18px 0 26px}.opt{margin-left:44px;color:#6e6579}.line{height:48px;border-bottom:2px solid #c9d8cf}.ans{color:#2f7a52;margin-top:8px}.sum{margin-top:30px;padding:24px 30px;border:2px dashed #c9bfb5;border-radius:24px}${answer ? '.wm{position:fixed;right:60px;top:60px;color:#c2673f;font-size:36px}' : ''}</style></head><body>${answer ? '<div class="wm">答案版</div>' : ''}<header><h1>${esc(card.meta.title || card.meta.unit)}</h1><p>${esc(card.meta.class_name)} · ${esc(card.meta.subject)} · 截止 ${esc(card.meta.due)}</p></header>${sections}<div class="sum">${esc(card.summary)}</div></body></html>`
}
