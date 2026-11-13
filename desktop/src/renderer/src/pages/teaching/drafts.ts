// The structured drafts the five teaching tools edit, and the pure helpers
// that turn a Skill's reply into them. Shapes follow
// docs/plans/teaching-tools-implementation.md §2 (deck) and §3 (card); no
// React, no network.
import type { TeachingWeek } from '../../api/client'

export type ToolId = 'plan' | 'courseware' | 'card' | 'advice' | 'schedule'

export const TOOL_IDS: ToolId[] = ['plan', 'courseware', 'card', 'advice', 'schedule']

export const asToolId = (value: string): ToolId | null =>
  TOOL_IDS.includes(value as ToolId) ? (value as ToolId) : null

// ---------- deck (§2) ----------

export const DECK_THEMES = ['lecture', 'activity', 'review', 'warm', 'mint'] as const
export type DeckTheme = (typeof DECK_THEMES)[number]

/** The renderer's layout list (agent/tools/pptx/validation.py LAYOUTS). */
export const DECK_LAYOUTS = [
  'cover',
  'agenda',
  'objectives',
  'bullets',
  'two-col',
  'compare',
  'process',
  'timeline',
  'table',
  'image',
  'quote',
  'summary',
  'end',
] as const
export type DeckLayout = (typeof DECK_LAYOUTS)[number]

export interface DeckColumn {
  heading: string
  bullets: string[]
}

export interface DeckStep {
  label: string
  text: string
}

export interface DeckSlide {
  id: string
  layout: DeckLayout
  title: string
  subtitle?: string
  bullets?: string[]
  columns?: DeckColumn[]
  steps?: DeckStep[]
  table?: { headers: string[]; rows: string[][] }
  image?: { path: string; caption: string; fit: string }
  quote?: string
  notes?: string
}

export interface DeckMeta {
  title: string
  subtitle?: string
  stage?: string
  subject?: string
  book?: string
  unit?: string
  lesson_type?: string
  hours?: string
  teacher?: string
  date?: string
}

export interface DeckDraft {
  version: 1
  theme: DeckTheme
  meta: DeckMeta
  slides: DeckSlide[]
}

/** 讲稿 target length per slide (task brief: 80–200 characters). */
export const NOTES_MIN = 80
export const NOTES_MAX = 200

// ---------- card (§3) ----------

/** basic 基础 · advanced 提升 · challenge 挑战 (agent/teaching/render/card_html.py). */
export const CARD_TIERS = ['basic', 'advanced', 'challenge'] as const
export type CardTier = (typeof CARD_TIERS)[number]

/**
 * A card is a homework notice: each entry is a thing to do, so `task` is the
 * default. The older question types stay in the union because an existing
 * draft may still carry them; the renderer draws every entry the same way.
 */
export const CARD_ITEM_TYPES = ['task', 'fill', 'choice', 'short', 'read', 'match'] as const
export type CardItemType = (typeof CARD_ITEM_TYPES)[number]

export interface CardItem {
  no: number
  type: CardItemType
  stem: string
  /** What to copy, how to correct — one short line under the task. */
  requirement?: string
  /** Expected minutes; the card head sums these. */
  duration?: number
  options?: string[]
  lines?: number
  answer: string
}

export interface CardSection {
  heading: string
  tier: CardTier
  hint?: string
  items: CardItem[]
}

export interface CardMeta {
  class_name: string
  class_ids: string[]
  subject: string
  stage: string
  book: string
  unit: string
  title: string
  date: string
  due: string
  teacher: string
}

export interface CardDraft {
  version: 1
  meta: CardMeta
  summary: string
  sections: CardSection[]
  footer: { score: boolean }
}

/** The contract allows at most 4 sections of at most 8 items each. */
export const CARD_MAX_ITEMS_PER_SECTION = 8

// ---------- plan outline, advice actions ----------

/** One line of the lesson-plan outline: `序号 段名｜要点｜时长`. */
export interface OutlineRow {
  id: string
  title: string
  point: string
  time: string
}

export interface AdviceAction {
  id: string
  title: string
  when: string
  owner: string
  steps: string[]
  expected: string
}

// ---------- parsing ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value))

const strList = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : [])

let seq = 0
/** A local id for list rows; never sent as a contract field except deck slide ids. */
export const newId = (prefix = 'r'): string => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * The last fenced ```json block of a reply, parsed; falls back to the
 * outermost `{…}` span. Null when nothing parses.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fences[i][1])
    } catch {
      // Try the next block up.
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
  }
  return null
}

const asLayout = (value: unknown): DeckLayout =>
  DECK_LAYOUTS.includes(value as DeckLayout) ? (value as DeckLayout) : 'bullets'

const asTheme = (value: unknown): DeckTheme =>
  DECK_THEMES.includes(value as DeckTheme) ? (value as DeckTheme) : 'lecture'

export function normalizeSlide(raw: unknown): DeckSlide | null {
  if (!isRecord(raw)) return null
  const slide: DeckSlide = {
    id: str(raw.id) || newId('s'),
    layout: asLayout(raw.layout),
    title: str(raw.title),
  }
  if (raw.subtitle !== undefined) slide.subtitle = str(raw.subtitle)
  if (Array.isArray(raw.bullets)) slide.bullets = strList(raw.bullets)
  if (Array.isArray(raw.columns)) {
    slide.columns = raw.columns.filter(isRecord).map((col) => ({ heading: str(col.heading), bullets: strList(col.bullets) }))
  }
  if (Array.isArray(raw.steps)) {
    slide.steps = raw.steps.filter(isRecord).map((step) => ({ label: str(step.label), text: str(step.text) }))
  }
  if (isRecord(raw.table)) {
    const rows = Array.isArray(raw.table.rows) ? raw.table.rows.map(strList) : []
    slide.table = { headers: strList(raw.table.headers), rows }
  }
  if (isRecord(raw.image)) {
    slide.image = { path: str(raw.image.path), caption: str(raw.image.caption), fit: str(raw.image.fit) || 'contain' }
  }
  if (raw.quote !== undefined) slide.quote = str(raw.quote)
  if (raw.notes !== undefined) slide.notes = str(raw.notes)
  return slide
}

/** A reply (or a saved draft) as a deck; null when it has no slides. */
export function normalizeDeck(raw: unknown): DeckDraft | null {
  const root = isRecord(raw) && isRecord(raw.deck) ? raw.deck : raw
  if (!isRecord(root) || !Array.isArray(root.slides)) return null
  const slides = root.slides.map(normalizeSlide).filter((s): s is DeckSlide => s !== null)
  if (!slides.length) return null
  const meta = isRecord(root.meta) ? root.meta : {}
  return {
    version: 1,
    theme: asTheme(root.theme),
    meta: {
      title: str(meta.title) || slides[0].title,
      subtitle: str(meta.subtitle),
      stage: str(meta.stage),
      subject: str(meta.subject),
      book: str(meta.book),
      unit: str(meta.unit),
      lesson_type: str(meta.lesson_type),
      hours: str(meta.hours),
      teacher: str(meta.teacher),
      date: str(meta.date),
    },
    slides,
  }
}

const asTier = (value: unknown): CardTier => (CARD_TIERS.includes(value as CardTier) ? (value as CardTier) : 'basic')

const asItemType = (value: unknown): CardItemType =>
  CARD_ITEM_TYPES.includes(value as CardItemType) ? (value as CardItemType) : 'short'

export function normalizeCard(raw: unknown): CardDraft | null {
  const root = isRecord(raw) && isRecord(raw.card) ? raw.card : raw
  if (!isRecord(root) || !Array.isArray(root.sections)) return null
  const sections: CardSection[] = root.sections.filter(isRecord).map((sec) => ({
    heading: str(sec.heading),
    tier: asTier(sec.tier),
    hint: str(sec.hint),
    items: (Array.isArray(sec.items) ? sec.items : []).filter(isRecord).map((item, i) => {
      const out: CardItem = {
        no: Number(item.no) || i + 1,
        type: asItemType(item.type),
        stem: str(item.stem),
        answer: str(item.answer),
      }
      if (Array.isArray(item.options)) out.options = strList(item.options)
      if (item.lines !== undefined) out.lines = Number(item.lines) || 1
      return out
    }),
  }))
  if (!sections.some((sec) => sec.items.length)) return null
  const meta = isRecord(root.meta) ? root.meta : {}
  const footer = isRecord(root.footer) ? root.footer : {}
  return {
    version: 1,
    meta: {
      class_name: str(meta.class_name),
      class_ids: strList(meta.class_ids),
      subject: str(meta.subject),
      stage: str(meta.stage),
      book: str(meta.book),
      unit: str(meta.unit),
      title: str(meta.title),
      date: str(meta.date),
      due: str(meta.due),
      teacher: str(meta.teacher),
    },
    summary: str(root.summary),
    sections,
    footer: { score: footer.score !== false },
  }
}

/** Renumber every item 1…n across sections, the order the card prints in. */
export function renumberCard(card: CardDraft): CardDraft {
  let no = 0
  return {
    ...card,
    sections: card.sections.map((sec) => ({ ...sec, items: sec.items.map((item) => ({ ...item, no: ++no })) })),
  }
}

/**
 * The lesson-plan outline: seven `序号 段名｜要点｜时长` lines
 * (skills/lesson-plan/SKILL.md §2), or a JSON `outline` array of the same.
 */
export function parseOutline(text: string): OutlineRow[] {
  const json = extractJson(text)
  if (isRecord(json) && Array.isArray(json.outline) && json.outline.length) {
    return json.outline.map((row) => {
      if (typeof row === 'string') return rowFromLine(row)
      const rec = isRecord(row) ? row : {}
      return { id: newId('o'), title: str(rec.title), point: str(rec.point), time: str(rec.time) }
    })
  }
  const rows: OutlineRow[] = []
  for (const line of text.split('\n')) {
    if (/^\s*\d+[.、\s]/.test(line) && line.includes('｜')) rows.push(rowFromLine(line))
  }
  return rows
}

function rowFromLine(line: string): OutlineRow {
  const [head, point = '', time = ''] = line.split('｜').map((part) => part.trim())
  return { id: newId('o'), title: head.replace(/^\s*\d+[.、]?\s*/, ''), point, time }
}

/** Outline rows back into the line format the draft step reads. */
export const outlineLines = (rows: OutlineRow[]): string[] =>
  rows.map((row, i) => `${i + 1} ${row.title}｜${row.point}｜${row.time}`)

export function normalizeWeeks(raw: unknown): TeachingWeek[] {
  const list = isRecord(raw) ? raw.weeks : raw
  if (!Array.isArray(list)) return []
  return list.filter(isRecord).map((row, i) => ({
    week: Number(row.week) || i + 1,
    unit: str(row.unit),
    topic: str(row.topic),
    periods: Math.max(0, Number(row.periods) || 0),
    goal: str(row.goal),
    assess: str(row.assess),
  }))
}

export function normalizeActions(raw: unknown): AdviceAction[] {
  const list = isRecord(raw) ? raw.actions : null
  if (!Array.isArray(list)) return []
  return list.filter(isRecord).map((row) => ({
    id: newId('a'),
    title: str(row.title),
    when: str(row.when),
    owner: str(row.owner),
    steps: strList(row.steps),
    expected: str(row.expected),
  }))
}

/** Weeks renumbered from `start` in their current order. */
export const renumberWeeks = (weeks: TeachingWeek[], start = 1): TeachingWeek[] =>
  weeks.map((row, i) => ({ ...row, week: start + i }))

/**
 * Fit the table into `target` weeks by merging the adjacent pair with the
 * fewest combined periods, repeatedly; topics join with ` / `, periods add.
 * Merging the lightest pair keeps the heavy weeks intact, which is what a
 * teacher cutting two weeks out of a term usually does by hand.
 */
export function compressWeeks(weeks: TeachingWeek[], target: number): TeachingWeek[] {
  const rows = weeks.map((row) => ({ ...row }))
  const goal = Math.max(1, Math.floor(target))
  while (rows.length > goal) {
    let best = 0
    for (let i = 1; i < rows.length - 1; i++) {
      if (rows[i].periods + rows[i + 1].periods < rows[best].periods + rows[best + 1].periods) best = i
    }
    const a = rows[best]
    const b = rows[best + 1]
    const join = (x: string, y: string): string => [x, y].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join(' / ')
    rows.splice(best, 2, {
      week: a.week,
      unit: join(a.unit, b.unit),
      topic: join(a.topic, b.topic),
      periods: a.periods + b.periods,
      goal: join(a.goal, b.goal),
      assess: join(a.assess, b.assess),
    })
  }
  return rows
}

/** A file-name-safe slug that keeps CJK characters. */
export const slugify = (value: string): string =>
  value
    .trim()
    .replace(/[\\/:*?"<>|#%\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'draft'

/** Move one element of a list; out-of-range targets are clamped. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item)
  return next
}
