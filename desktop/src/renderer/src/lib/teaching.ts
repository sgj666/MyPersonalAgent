// Pure helpers behind the teaching pages: paste parsing, calendar maths and
// the small formatting rules the five views share. No React, no network — a
// page keeps only what is specific to it.
import type {
  HomeworkKind,
  HomeworkState,
  TeachingStudentInput,
  TimetableKind,
  TimetablePeriod,
  TimetableSlot,
} from '../types'

export const TIMETABLE_KINDS: TimetableKind[] = [
  'regular',
  'morning',
  'tutor',
  'evening',
  'after_school',
  'research',
  'duty',
]

export const HOMEWORK_KINDS: HomeworkKind[] = [
  'practice',
  'paper',
  'preview',
  'project',
  'correction',
]

export const HOMEWORK_STATES: HomeworkState[] = ['submitted', 'excellent', 'fix', 'missing']

/** Monday to Friday; the grid's columns. */
export const WEEKDAYS = [1, 2, 3, 4, 5]

/** A usable day when the table has no periods yet: eight 40-minute blocks. */
export const DEFAULT_PERIODS: TimetablePeriod[] = [
  { index: 1, start: '08:00', end: '08:40' },
  { index: 2, start: '08:50', end: '09:30' },
  { index: 3, start: '09:50', end: '10:30' },
  { index: 4, start: '10:40', end: '11:20' },
  { index: 5, start: '11:30', end: '12:10' },
  { index: 6, start: '14:00', end: '14:40' },
  { index: 7, start: '14:50', end: '15:30' },
  { index: 8, start: '15:50', end: '16:30' },
]

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD` on the teacher's own calendar, not UTC. */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function todayISO(): string {
  return isoDate(new Date())
}

/** `date` shifted by whole days, staying on the local calendar. */
export function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((part) => Number(part))
  if (!y || !m || !d) return isoDate(new Date())
  return isoDate(new Date(y, m - 1, d + days))
}

/** 1 = Monday … 5 = Friday, 0/6 for the weekend. */
export function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map((part) => Number(part))
  if (!y || !m || !d) return new Date().getDay()
  return new Date(y, m - 1, d).getDay()
}

export function weekdayLabel(weekday: number): string {
  return `tw_weekday_${weekday}`
}

/**
 * The next day this class actually has a lesson, scanning two weeks ahead.
 * The homework form uses it as the default deadline (§4: 截止日默认该班下一次上课).
 * A class with no timetable falls back to tomorrow.
 */
export function nextClassDate(slots: TimetableSlot[], classId: string, from = todayISO()): string {
  const days = new Set(slots.filter((slot) => slot.class_id === classId).map((slot) => slot.weekday))
  for (let offset = 1; offset <= 14; offset++) {
    const iso = shiftDate(from, offset)
    if (days.has(weekdayOf(iso))) return iso
  }
  return shiftDate(from, 1)
}

// ---------------------------------------------------------
// Roster paste (§4 班级与学生: 识别 姓名/学号/性别/标签/备注 表头，无表头按
// 学号,姓名 兜底，预览后再落库)
// ---------------------------------------------------------

export interface RosterParse {
  rows: TeachingStudentInput[]
  /** Rows dropped for a missing name or number. */
  skipped: number
  /** Repeated 学号 inside the paste; the later row wins, as an upsert would. */
  duplicates: number
  hasHeader: boolean
}

const ROSTER_HEADERS: Record<'no' | 'name' | 'gender' | 'tags' | 'note', string[]> = {
  no: ['学号', '学籍号', '编号', '序号', 'no', 'id', 'number'],
  name: ['姓名', '学生姓名', '名字', 'name', 'student'],
  gender: ['性别', 'gender', 'sex'],
  tags: ['标签', '分组', '组别', 'tags', 'tag'],
  note: ['备注', '说明', 'note', 'remark', 'remarks'],
}

type RosterField = keyof typeof ROSTER_HEADERS

/** Excel copies rows tab-separated; a hand-typed list may use commas. */
function splitRow(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map((cell) => cell.trim())
  if (/[,，]/.test(line)) return line.split(/[,，]/).map((cell) => cell.trim())
  return line.trim().split(/\s{2,}/).map((cell) => cell.trim())
}

function normalizeHeader(cell: string): RosterField | null {
  const clean = cell.replace(/\s+/g, '').toLowerCase()
  for (const field of Object.keys(ROSTER_HEADERS) as RosterField[]) {
    if (ROSTER_HEADERS[field].includes(clean)) return field
  }
  return null
}

function splitTags(cell: string): string[] {
  return cell
    .split(/[,，、;；/\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

export function parseRosterPaste(text: string): RosterParse {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return { rows: [], skipped: 0, duplicates: 0, hasHeader: false }

  const first = splitRow(lines[0])
  const mapped = first.map(normalizeHeader)
  const hasHeader = mapped.some((field) => field !== null)
  // No header: the plan's fallback order, 学号 then 姓名, plus the optional
  // columns if the paste carries them.
  const columns: (RosterField | null)[] = hasHeader
    ? mapped
    : (['no', 'name', 'gender', 'tags', 'note'] as RosterField[]).slice(0, first.length)

  const index: Partial<Record<RosterField, number>> = {}
  columns.forEach((field, i) => {
    if (field && index[field] === undefined) index[field] = i
  })

  const seen = new Map<string, number>()
  let duplicates = 0
  let skipped = 0
  const rows: TeachingStudentInput[] = []

  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cells = splitRow(line)
    const cell = (field: RosterField): string => {
      const i = index[field]
      return i === undefined ? '' : (cells[i] || '').trim()
    }
    const no = cell('no')
    const name = cell('name')
    if (!no || !name) {
      skipped++
      continue
    }
    const row: TeachingStudentInput = {
      no,
      name,
      gender: cell('gender'),
      tags: splitTags(cell('tags')),
      note: cell('note'),
    }
    const at = seen.get(no)
    if (at !== undefined) {
      duplicates++
      rows[at] = row
    } else {
      seen.set(no, rows.length)
      rows.push(row)
    }
  }

  return { rows, skipped, duplicates, hasHeader }
}

// ---------------------------------------------------------
// Teaching-plan paste (§4 教学进度: 可从教学计划整段粘贴)
// ---------------------------------------------------------

export interface PlanRow {
  topic: string
  planned: number
}

const PLAN_HEADER = /课题|单元|教学内容|教学计划|周次|课时/

function cleanTopic(text: string): string {
  return text
    .replace(/^[-*•·\d.、)）\s]+/, '')
    .replace(/^\|+|\|+$/g, '')
    .replace(/[:：]\s*$/, '')
    .trim()
}

/**
 * One row per topic. Accepts a Markdown table pasted whole (周次 / 单元 / 课题 /
 * 课时), a tab-separated table, or plain lines ending in 课时. The topic is the
 * first text cell that is not a week or a number; the planned hours are the
 * first integer after it, defaulting to 1.
 */
export function parsePlanPaste(text: string): PlanRow[] {
  const rows: PlanRow[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    // A table's alignment row: only |, -, : and spaces.
    if (/^[|\s:-]+$/.test(trimmed)) continue

    // A line that leads with 第3周 has its week outside the topic; the bare
    // number a teacher leaves at the end of such a line is the period count.
    const hadWeek = /^第?\d+周\s*/.test(trimmed)
    const line = hadWeek ? trimmed.replace(/^第?\d+周\s*/, '') : trimmed
    if (!line) continue

    let cells = line.includes('|') ? line.split('|').map((cell) => cell.trim()) : splitRow(line)
    cells = cells.filter(Boolean)
    if (!cells.length) continue
    if (cells.some((cell) => /^(课题|教学内容|单元名称|单元|周次|课时)$/.test(cell)) && !/\d/.test(cells.join(''))) {
      continue
    }

    // 第3周 / 3周 are schedule markers, never the topic.
    const weekCells = new Set(
      cells.map((cell, index) => (/^第?\d+周$/.test(cell) ? index : -1)).filter((index) => index >= 0)
    )
    // In a 周次 / 单元 / 课题 / 课时 table the hours sit in the last numeric
    // column, so the leading week number is not mistaken for a period count.
    let plannedAt = -1
    cells.forEach((cell, index) => {
      if (index > 0 && !weekCells.has(index) && /^\d+$/.test(cell)) plannedAt = index
    })

    const rest = cells.filter(
      (cell, index) => index !== plannedAt && !weekCells.has(index) && !/^\d+$/.test(cell)
    )
    let topic = cleanTopic(rest.join(' '))
    let planned = plannedAt >= 0 ? Number(cells[plannedAt]) : 0

    if (!topic) continue
    // "Unit 3 4课时" pasted as one text line keeps its trailing hours.
    const hours = topic.match(/^(.+?)\s*[（(]?\s*(\d+)\s*(?:课时|节)\s*[）)]?$/)
    if (hours) {
      topic = cleanTopic(hours[1])
      planned = planned || Number(hours[2])
    }
    if (hadWeek && !planned) {
      const trailing = topic.match(/^(.+?)\s+(\d+)$/)
      if (trailing) {
        topic = cleanTopic(trailing[1])
        planned = Number(trailing[2])
      }
    }
    if (!topic) continue
    rows.push({ topic, planned: planned || 1 })
  }
  return rows
}

// ---------------------------------------------------------
// Score block paste (§4 成绩: 整块粘贴)
// ---------------------------------------------------------

/** A pasted block as raw cells; the caller maps them onto the visible columns. */
export function parseScoreBlock(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) =>
      (line.includes('\t') ? line.split('\t') : line.split(/[,，]/)).map((cell) => cell.trim())
    )
}

/** A score cell, or null for an empty / non-numeric / 缺考 cell. */
export function parseScoreCell(cell: string): number | null {
  const clean = cell.trim()
  if (!clean || /^(缺考|缺|-|—|×|x)$/i.test(clean)) return null
  const value = Number(clean)
  return Number.isFinite(value) ? value : null
}

// ---------------------------------------------------------
// Term pacing (§4 教学进度 自动算快/慢)
// ---------------------------------------------------------

/** The Chinese semester a date falls in, used until the teacher picks dates. */
export function defaultTerm(now = new Date()): { start: string; end: string } {
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  if (month >= 8) return { start: `${year}-09-01`, end: `${year + 1}-02-01` }
  if (month <= 1) return { start: `${year - 1}-09-01`, end: `${year}-02-01` }
  return { start: `${year}-02-01`, end: `${year}-08-01` }
}

/** How much of the term has gone by, clamped to 0–1. */
export function termFraction(start: string, end: string, now = new Date()): number {
  const from = new Date(`${start}T00:00:00`).getTime()
  const to = new Date(`${end}T00:00:00`).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0
  const ratio = (now.getTime() - from) / (to - from)
  return Math.max(0, Math.min(1, ratio))
}

export interface Pace {
  planned: number
  taught: number
  /** Periods the linear plan expects by now. */
  expected: number
  /** taught − expected; positive is ahead. */
  delta: number
  status: 'ahead' | 'on' | 'behind' | 'done' | 'empty'
}

/** Totals against the term's elapsed share: ±1 period is "on pace". */
export function computePace(items: { planned_periods: number; taught_periods: number }[], fraction: number): Pace {
  const planned = items.reduce((sum, item) => sum + (Number(item.planned_periods) || 0), 0)
  const taught = items.reduce((sum, item) => sum + (Number(item.taught_periods) || 0), 0)
  if (!planned) return { planned, taught, expected: 0, delta: 0, status: 'empty' }
  if (taught >= planned) return { planned, taught, expected: planned, delta: taught - planned, status: 'done' }
  const expected = Math.round(planned * fraction)
  const delta = taught - expected
  return {
    planned,
    taught,
    expected,
    delta,
    status: delta >= 1 ? 'ahead' : delta <= -1 ? 'behind' : 'on',
  }
}

// ---------------------------------------------------------
// Formatting
// ---------------------------------------------------------

/** The store reports rates as percentages already (0–100, two decimals). */
export function percentText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${Math.round(value * 10) / 10}%`
}

/** One decimal, or an em dash for a value that isn't there. */
export function numberText(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return Number(value.toFixed(digits)).toString()
}

/** Strip a trailing `.0` so 3.0 reads as 3. */
export function wholeText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return Number(value.toFixed(2)).toString()
}
