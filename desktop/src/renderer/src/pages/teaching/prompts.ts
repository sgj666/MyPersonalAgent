// The requests the five tool pages send to their Skills. The page passes
// structured parameters only; the output shape is owned by each SKILL.md
// (design §2 principle 5), so these strings never restate it beyond "answer
// with the JSON block your contract defines". Chinese because the Skills and
// the teachers both read it; kept out of the .tsx files on purpose.
import type { TeachingFact, TeachingWeek } from '../../api/client'
import type { CardDraft, CardTier, DeckDraft, DeckSlide, OutlineRow } from './drafts'
import { outlineLines } from './drafts'

const block = (value: unknown): string => '```json\n' + JSON.stringify(value, null, 2) + '\n```'

const ask = (skill: string, params: unknown, reply: string): string =>
  [`请使用 skill「${skill}」。入参：`, block(params), '', reply].join('\n')

export interface PlanParams {
  stage: string
  subject: string
  book: string
  unit: string
  lesson_type: string
  hours: string
  material_paths: string[]
}

export const planOutlinePrompt = (p: PlanParams): string =>
  ask('lesson-plan', { mode: 'outline', ...p, outline: [] }, '只出大纲（7 行），不要写全文。')

export const planDraftPrompt = (p: PlanParams, rows: OutlineRow[]): string =>
  ask(
    'lesson-plan',
    { mode: 'draft', ...p, outline: outlineLines(rows) },
    '按这份教师改过的大纲写全文 Markdown，段落与大纲一一对应，并落盘到 knowledge/教案/。'
  )

export interface DeckParams {
  unit: string
  plan_path: string
  theme: string
  pages: number
}

export const deckOutlinePrompt = (p: DeckParams): string =>
  ask(
    'courseware-ppt',
    { mode: 'outline', ...p },
    '先只出页纲：按 deck JSON 契约输出一个 ```json 代码块（含每页 layout / 标题 / 要点 / notes），不要渲染文件。'
  )

export const deckRedrawPrompt = (deck: DeckDraft, slide: DeckSlide, index: number): string =>
  ask(
    'courseware-ppt',
    { mode: 'slide', index: index + 1, meta: deck.meta, theme: deck.theme, slide },
    `只重写第 ${index + 1} 页，其它页不变；输出这一页的 slide JSON（一个 \`\`\`json 代码块，id 保持 ${slide.id}）。`
  )

export interface CardParams {
  class_ids: string[]
  class_names: string[]
  kind: string
  due: string
  intent: string
  unit: string
  evidence: TeachingFact[]
  knowledge_paths: string[]
}

export const cardPrompt = (p: CardParams): string =>
  ask(
    'homework-card',
    p,
    '先出题目清单：按 Card JSON 契约输出一个 ```json 代码块（sections 分 basic / advanced / challenge 三档，含 summary 家长一句话），不要渲染文件。'
  )

export interface AdviceParams {
  class_id: string
  class_name: string
  unit: string
  focus: string
  range: string
  facts: TeachingFact[]
}

export const advicePrompt = (p: AdviceParams): string =>
  ask(
    'teaching-advice',
    p,
    '事实已由系统算好，不要改写数字；只做判断与行动，输出 {facts, actions[{title, when, owner, steps, expected}]} 的 ```json 代码块。'
  )

/** A follow-up question with the facts attached, so the answer stays on the numbers. */
export const adviceFollowUp = (question: string, facts: TeachingFact[]): string =>
  [question, '', '（本班事实，供参考，不要改写数字）', block(facts)].join('\n')

export interface ScheduleParams {
  term: string
  book: string
  weeks: number
  start_week: number
  periods_per_week: number
  class_ids: string[]
  scope: string
}

export const schedulePrompt = (p: ScheduleParams, current: TeachingWeek[]): string =>
  ask(
    'teaching-plan',
    { ...p, current_weeks: current },
    '排出周次表：输出 {"weeks":[{week, unit, topic, periods, goal, assess}]} 的 ```json 代码块，不要写入进度。'
  )

/** Data values the store and the Skills read in Chinese. */
export const STAGES = ['小学', '初中', '高中']
export const LESSON_TYPES = ['新授课', '读写课', '听说课', '复习课', '习题课']
export const CARD_KINDS = ['基础巩固', '单元过关', '周末提升']
export const ADVICE_FOCUS = ['课堂参与', '分层', '作业']
export const ADVICE_RANGES = ['近两周', '本月', '本学期']

export const TIER_HEADINGS: Record<CardTier, string> = {
  basic: '一、基础巩固',
  advanced: '二、能力提升',
  challenge: '三、拓展挑战',
}

export const REVIEW_TOPIC = '复习周'

/** The empty card a teacher starts from when no Skill has answered yet. */
export const emptyCard = (meta: Partial<CardDraft['meta']>): CardDraft => ({
  version: 1,
  meta: {
    class_name: '',
    class_ids: [],
    subject: '',
    stage: '',
    book: '',
    unit: '',
    title: '',
    date: '',
    due: '',
    teacher: '',
    ...meta,
  },
  summary: '',
  sections: [],
  footer: { score: true, parent_sign: true },
})

/** The knowledge folders the tools read from (folder names are data). */
export const KB = {
  textbook: '教材',
  standards: ['课标', '课程标准'],
  plans: '教案',
  feedback: '作业反馈',
} as const
