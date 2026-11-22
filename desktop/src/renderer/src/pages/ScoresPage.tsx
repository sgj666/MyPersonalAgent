import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChartLine, GraduationCap, Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { t, tf } from '../i18n'
import apiClient from '../api/client'
import { askConfirm } from '../store/confirmStore'
import {
  errorText,
  numberText,
  parseScoreBlock,
  parseScoreCell,
  percentText,
  todayISO,
  wholeText,
} from '../lib/teaching'
import { Empty, Loading, Modal, PageError, Status } from './teachingShared'
import AiAssistButton from '../components/AiAssistButton'
import Markdown from '../components/Markdown'
import type {
  AnalysisTrendPoint,
  ExamFields,
  ExamItem,
  ScoreEntry,
  TeachingAnalysis,
  TeachingClass,
  TeachingExam,
  TeachingReport,
  TeachingStudent,
} from '../types'

interface ScoresPageProps {
  baseUrl: string
}

const newItemKey = (items: ExamItem[]) => {
  let n = items.length + 1
  while (items.some((item) => item.key === `p${n}`)) n++
  return `p${n}`
}

/** New exam / edit exam, including the optional sub-score breakdown. */
const ExamDialog: React.FC<{
  initial: TeachingExam | null
  classes: TeachingClass[]
  onClose: () => void
  onSubmit: (fields: ExamFields) => Promise<void>
}> = ({ initial, classes, onClose, onSubmit }) => {
  const [name, setName] = useState(initial?.name || '')
  const [date, setDate] = useState(initial?.date || todayISO())
  const [subject, setSubject] = useState(initial?.subject || '')
  const [classIds, setClassIds] = useState<string[]>(initial?.class_ids || [])
  const [fullScore, setFullScore] = useState(String(initial?.full_score || 100))
  const [items, setItems] = useState<ExamItem[]>(initial?.items || [])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const full = Math.max(1, Number(fullScore) || 0)
  const itemTotal = items.reduce((sum, item) => sum + (Number(item.full) || 0), 0)
  const itemsMismatch = items.length > 0 && itemTotal !== full

  const toggleClass = (id: string) =>
    setClassIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))

  const setItem = (index: number, patch: Partial<ExamItem>) =>
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!name.trim()) {
      setError(t('tw_sc_exam_name_required'))
      return
    }
    if (!classIds.length) {
      setError(t('tw_sc_pick_class'))
      return
    }
    if (items.some((item) => !(Number(item.full) > 0))) {
      setError(t('tw_sc_item_full'))
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit({
        name: name.trim(),
        date,
        subject: subject.trim(),
        class_ids: classIds,
        full_score: full,
        items: items.filter((item) => item.label.trim()),
      })
    } catch (err) {
      setError(tf('tw_save_failed', { msg: errorText(err) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      titleId="twb-exam-dialog-title"
      title={t(initial ? 'tw_sc_exam_edit' : 'tw_sc_exam_new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="twb-btn" onClick={onClose}>
            {t('tw_cancel')}
          </button>
          <button type="submit" form="twb-exam-form" className="twb-btn twb-btn-primary" disabled={saving}>
            {t('tw_save')}
          </button>
        </>
      }
    >
      <form id="twb-exam-form" className="twb-form-body" onSubmit={submit}>
        <div className="twb-field-row">
          <label className="twb-field">
            <span>{t('tw_sc_exam_name')}</span>
            <input
              className="twb-input"
              type="text"
              required
              autoFocus
              maxLength={80}
              value={name}
              placeholder={t('tw_sc_exam_name_ph')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="twb-field">
            <span>{t('tw_sc_exam_date')}</span>
            <input
              className="twb-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        <div className="twb-field-row">
          <label className="twb-field">
            <span>{t('tw_sc_subject')}</span>
            <input
              className="twb-input"
              type="text"
              maxLength={20}
              value={subject}
              placeholder={t('tw_sc_subject_ph')}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label className="twb-field">
            <span>{t('tw_sc_full_score')}</span>
            <input
              className="twb-input"
              type="number"
              min={1}
              max={1000}
              value={fullScore}
              onChange={(e) => setFullScore(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="twb-field twb-fieldset">
          <legend>{t('tw_sc_classes')}</legend>
          <div className="twb-checks">
            {classes.map((item) => (
              <label key={item.id} className="twb-check">
                <input
                  type="checkbox"
                  checked={classIds.includes(item.id)}
                  onChange={() => toggleClass(item.id)}
                />
                <span>{item.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="twb-field twb-fieldset">
          <legend>{t('tw_sc_items')}</legend>
          <p className="twb-hint">{t('tw_sc_items_hint')}</p>
          {items.map((item, index) => (
            <div className="twb-exam-item-row" key={item.key}>
              <input
                className="twb-input"
                type="text"
                maxLength={12}
                value={item.label}
                placeholder={t('tw_sc_item_label')}
                onChange={(e) => setItem(index, { label: e.target.value })}
              />
              <input
                className="twb-input twb-narrow"
                type="number"
                min={1}
                max={1000}
                value={String(item.full)}
                onChange={(e) => setItem(index, { full: Number(e.target.value) || 0 })}
              />
              <button
                type="button"
                className="twb-icon-btn is-danger"
                aria-label={t('tw_delete')}
                onClick={() => setItems((prev) => prev.filter((_, at) => at !== index))}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div className="twb-exam-items-foot">
            <button
              type="button"
              className="twb-btn"
              onClick={() =>
                setItems((prev) => [
                  ...prev,
                  { key: newItemKey(prev), label: '', full: Math.max(1, Math.round(full / 2)) },
                ])
              }
            >
              <Plus size={14} />
              <span>{t('tw_sc_add_item')}</span>
            </button>
            {items.length > 0 && (
              <span className={`twb-hint${itemsMismatch ? ' is-error' : ''}`}>
                {tf('tw_sc_items_sum', { sum: itemTotal, full })}
              </span>
            )}
          </div>
        </fieldset>
        {error && <p className="twb-status is-error">{error}</p>}
      </form>
    </Modal>
  )
}

/** 报告里的图表：全部用后端算好的 facts 画，前端不做任何统计。 */
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Two decimals of a rate, so 40.43% does not read as 40.4% next to the prose. */
const percentExact = (value: number | null): string =>
  value === null ? '—' : `${Number(value.toFixed(2))}%`

const ReportVisuals: React.FC<{ facts?: TeachingReport['facts'] }> = ({ facts }) => {
  if (!facts) return null
  const overall = (facts.overall || {}) as Record<string, number | null>
  const items = (facts.items || []) as NonNullable<TeachingReport['facts']>['items'] & object[]
  const bands = (facts.distribution || []) as { label: string; count: number }[]
  const trend = (facts.trend || []) as { name: string; average: number }[]
  const top = (facts.top || []) as { rank: number; name: string; total: number }[]

  const kpi = (label: string, value: string, hint?: string) => (
    <div className="twb-kpi" key={label}>
      <span>{label}</span>
      <b>{value}</b>
      {hint && <small>{hint}</small>}
    </div>
  )

  const bandMax = Math.max(1, ...bands.map((band) => band.count))

  return (
    <div className="twb-visuals">
      <div className="twb-kpis">
        {kpi(t('tw_an_count'), wholeText(num(overall.scored) ?? 0), tf('tw_an_absent_n', { n: num(overall.absent) ?? 0 }))}
        {kpi(t('tw_an_average'), numberText(num(overall.average), 2))}
        {kpi('最高 / 最低', `${numberText(num(overall.max), 2)} / ${numberText(num(overall.min), 2)}`)}
        {kpi(t('tw_an_pass'), percentExact(num(overall.pass_rate)))}
        {kpi(t('tw_an_excellent'), percentExact(num(overall.excellent_rate)))}
        {kpi(t('tw_an_stddev'), numberText(num(overall.stddev), 2))}
      </div>

      {(bands.length > 0 || items.length > 0) && (
        <div className="twb-visual-row">
          {bands.length > 0 && (
            <section className="twb-vpanel">
              <h4>{t('tw_an_bands')}</h4>
              <div className="twb-bands">
                {bands.map((band, index) => (
                  <div className="twb-band" key={band.label}>
                    <span className="twb-band-label">{band.label}</span>
                    <div className="twb-band-track">
                      <i
                        style={{ width: `${Math.round((band.count / bandMax) * 100)}%` }}
                        data-tone={index === 0 ? 'low' : index >= bands.length - 1 ? 'high' : 'mid'}
                      />
                    </div>
                    <b>{band.count}</b>
                  </div>
                ))}
              </div>
            </section>
          )}

          {items.length > 0 && (
            <section className="twb-vpanel">
              <h4>{t('tw_an_rate')}</h4>
              <div className="twb-bands">
                {items.map((item) => {
                  const rate = num(item.rate) ?? 0
                  return (
                    <div className="twb-band" key={item.label}>
                      <span className="twb-band-label">{item.label}</span>
                      <div className="twb-band-track">
                        <i
                          style={{ width: `${Math.max(2, Math.min(100, rate))}%` }}
                          data-tone={rate >= 80 ? 'high' : rate >= 55 ? 'mid' : 'low'}
                        />
                      </div>
                      <b>{percentExact(num(item.rate))}</b>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {(trend.length > 1 || top.length > 0) && (
        <div className="twb-visual-row">
          {trend.length > 1 && (
            <section className="twb-vpanel">
              <h4>{t('tw_an_trend')}</h4>
              <div className="twb-trend">
                {trend.map((point) => {
                  const peak = Math.max(...trend.map((row) => row.average), 1)
                  return (
                    <div className="twb-trend-col" key={point.name}>
                      <b>{numberText(point.average)}</b>
                      <div className="twb-trend-bar">
                        <i style={{ height: `${Math.max(6, (point.average / peak) * 100)}%` }} />
                      </div>
                      <span>{point.name}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {top.length > 0 && (
            <section className="twb-vpanel">
              <h4>{t('tw_an_top')}</h4>
              <ol className="twb-podium">
                {top.slice(0, 5).map((row) => (
                  <li key={`${row.rank}-${row.name}`} data-rank={row.rank}>
                    <span className="twb-podium-rank">{row.rank}</span>
                    <span className="twb-podium-name">{row.name}</span>
                    <b>{numberText(num(row.total))}</b>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

const Column = { total: 'total' } as const

const ScoresPage: React.FC<ScoresPageProps> = ({ baseUrl }) => {
  const [classes, setClasses] = useState<TeachingClass[]>([])
  const [exams, setExams] = useState<TeachingExam[]>([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [classId, setClassId] = useState('')
  const [students, setStudents] = useState<TeachingStudent[]>([])
  const [scores, setScores] = useState<Record<string, ScoreEntry>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scoresLoading, setScoresLoading] = useState(false)
  const [scoresError, setScoresError] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'entry' | 'analysis'>('entry')
  const [dialog, setDialog] = useState<{ open: boolean; target: TeachingExam | null }>({
    open: false,
    target: null,
  })
  // 学科筛选：null = 全部（所有分项 + 总分），否则只显示选中的分项。
  const [subjectKeys, setSubjectKeys] = useState<string[] | null>(null)
  // 表头排序：默认按学号升序，数字列可点。缺考/未录的格子永远排在最后。
  // 序号 = 当前显示的第几行，不参与排序；默认保持导入时的顺序。
  const [sortKey, setSortKey] = useState('seq')
  const [sortAsc, setSortAsc] = useState(true)
  // 每场考试一份 AI 分析报告，跟着考试走（切换考试即换）。
  const [report, setReport] = useState<TeachingReport | null>(null)
  const [reportKey, setReportKey] = useState('')
  const [reportGenerating, setReportGenerating] = useState(false)
  const [reportError, setReportError] = useState('')
  const gridRef = useRef<HTMLDivElement>(null)
  const scoreToken = useRef(0)
  const studentToken = useRef(0)

  const selectedExam = exams.find((exam) => exam.id === selectedExamId) || null

  const pickExam = (exam: TeachingExam | undefined) => {
    setSelectedExamId(exam?.id || '')
    setReport(null)
    setReportKey('')
    setReportError('')
    setClassId(exam?.class_ids[0] || '')
    setView('entry')
  }

  const load = useCallback(async () => {
    apiClient.setBaseUrl(baseUrl)
    setError('')
    try {
      const [classRows, examRows] = await Promise.all([
        apiClient.listTeachingClasses(),
        apiClient.listTeachingExams(),
      ])
      setClasses(classRows)
      setExams(examRows)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  // Selection follows what the server returned: keep the exam and class the
  // teacher already had open, else fall back to the first of each.
  useEffect(() => {
    if (!exams.length) return
    setSelectedExamId((prev) => (exams.some((exam) => exam.id === prev) ? prev : exams[0].id))
  }, [exams])

  useEffect(() => {
    const exam = exams.find((item) => item.id === selectedExamId)
    if (!exam) return
    setClassId((prev) => (exam.class_ids.includes(prev) ? prev : exam.class_ids[0] || ''))
  }, [exams, selectedExamId])

  // 默认只看这门考试教的学科：只教英语的老师录分时，不该横向滚过七列。
  // 没有分项（只记总分）或学科名对不上分项时回到「全部」。
  useEffect(() => {
    const exam = exams.find((item) => item.id === selectedExamId)
    if (!exam) {
      setSubjectKeys(null)
      return
    }
    const match = exam.items.find(
      (item) => item.label === exam.subject || item.key === exam.subject,
    )
    setSubjectKeys(match ? [match.key] : null)
  }, [exams, selectedExamId])

  useEffect(() => {
    if (!selectedExamId) {
      setScores({})
      return
    }
    const token = ++scoreToken.current
    setScoresLoading(true)
    setScoresError('')
    apiClient
      .getTeachingScores(selectedExamId)
      .then((rows) => {
        if (token === scoreToken.current) setScores(rows)
      })
      .catch((err) => {
        if (token === scoreToken.current) setScoresError(errorText(err))
      })
      .finally(() => {
        if (token === scoreToken.current) setScoresLoading(false)
      })
  }, [selectedExamId])

  useEffect(() => {
    if (!classId) {
      setStudents([])
      return
    }
    const token = ++studentToken.current
    apiClient
      .listTeachingStudents(classId)
      .then((rows) => {
        if (token === studentToken.current) setStudents(rows)
      })
      .catch((err) => {
        if (token === studentToken.current) setStatus(tf('tw_load_failed_msg', { msg: errorText(err) }))
      })
  }, [classId])


  // 打开分析页时才去取报告；没有就显示「生成」入口，不自动调模型。
  useEffect(() => {
    if (view !== 'analysis' || !selectedExam) return
    if (reportKey === selectedExam.id) return
    let cancelled = false
    apiClient
      .getTeachingReport(selectedExam.id)
      .then((stored) => {
        if (cancelled) return
        setReport(stored)
        setReportKey(selectedExam.id)
      })
      .catch(() => {
        if (!cancelled) setReportKey(selectedExam.id)
      })
    return () => {
      cancelled = true
    }
  }, [view, selectedExam, reportKey])

  const generateReport = async () => {
    if (!selectedExam || reportGenerating) return
    setReportGenerating(true)
    setReportError('')
    try {
      const next = await apiClient.generateTeachingReport(selectedExam.id)
      setReport(next)
      setReportKey(selectedExam.id)
      if (!next?.ok) setReportError(t('tw_an_ai_failed'))
    } catch (err) {
      setReportError(errorText(err))
    } finally {
      setReportGenerating(false)
    }
  }

  const itemColumns = selectedExam?.items || []
  const allItemKeys = itemColumns.map((item) => item.key)
  // 「全部」画所有分项 + 总分；选了具体学科时只画那几列，没有意义的总分列收起。
  const shownItems =
    subjectKeys === null ? itemColumns : itemColumns.filter((item) => subjectKeys.includes(item.key))
  const showTotal = subjectKeys === null
  const columns = [...shownItems.map((item) => item.key), ...(showTotal ? [Column.total] : [])]

  // 从「全部」点某一科 = 只看这一科；再从那里多选。取消到一列不剩、或选满，
  // 都回到「全部」：表格不能没有列。
  const toggleSubject = (key: string) => {
    if (subjectKeys === null) {
      setSubjectKeys([key])
      return
    }
    const next = subjectKeys.includes(key)
      ? subjectKeys.filter((item) => item !== key)
      : [...subjectKeys, key]
    setSubjectKeys(next.length === 0 || next.length === allItemKeys.length ? null : next)
  }

  // 实时排名：看总分时按总分排，筛了学科时按所选学科的合计排。
  // 同分同名次（1、2、2、4），缺考/未录不参与排名。
  const rankByStudent = useMemo(() => {
    const value = (student: TeachingStudent): number | null => {
      const entry = scores[student.id]
      if (!entry) return null
      if (showTotal) return entry.total
      const values = shownItems
        .map((item) => entry.items?.[item.key])
        .filter((item): item is number => item !== null && item !== undefined)
      if (!values.length) return null
      return Number(values.reduce((sum, item) => sum + item, 0).toFixed(2))
    }
    const ranked = students
      .map((student) => ({ id: student.id, value: value(student) }))
      .filter((row): row is { id: string; value: number } => row.value !== null)
      .sort((a, b) => b.value - a.value)
    const ranks = new Map<string, number>()
    ranked.forEach((row, index) => {
      const prev = ranked[index - 1]
      ranks.set(row.id, prev && prev.value === row.value ? ranks.get(prev.id)! : index + 1)
    })
    return ranks
  }, [students, scores, showTotal, shownItems])

  const toggleSort = (key: string) => {
    if (key === sortKey) {
      setSortAsc((prev) => !prev)
      return
    }
    setSortKey(key)
    // 名次从小到大（第一名在最上面），分数从高到低，姓名正序。
    setSortAsc(key === 'rank' || (!allItemKeys.includes(key) && key !== Column.total))
  }

  const sortValue = (student: TeachingStudent): number | string | null => {
    if (sortKey === 'name') return student.name
    if (sortKey === 'rank') return rankByStudent.get(student.id) ?? null
    if (sortKey === Column.total) return scores[student.id]?.total ?? null
    const value = scores[student.id]?.items?.[sortKey]
    return value === null || value === undefined ? null : value
  }

  const rows = useMemo(() => {
    // Nothing clicked yet: keep the order the roster arrived in.
    if (sortKey === 'seq') return students
    const direction = sortAsc ? 1 : -1
    return [...students].sort((a, b) => {
      const left = sortValue(a)
      const right = sortValue(b)
      if (left === null && right === null) return 0
      if (left === null) return 1
      if (right === null) return -1
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction
      return String(left).localeCompare(String(right), 'zh-Hans-CN', { numeric: true }) * direction
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [students, sortKey, sortAsc, scores, rankByStudent])

  // 表头按钮：同一列再点一次反向。
  const sortHeader = (key: string, label: React.ReactNode) => {
    const active = sortKey === key
    return (
      <button
        type="button"
        className="twb-sort"
        aria-pressed={active}
        title={t('tw_sc_sort_hint')}
        onClick={() => toggleSort(key)}
      >
        {label}
        <span className={`twb-sort-mark${active ? ' is-active' : ''}`}>
          {active ? (sortAsc ? '↑' : '↓') : '↕'}
        </span>
      </button>
    )
  }

  const isAbsent = (entry: ScoreEntry | undefined): boolean =>
    Boolean(entry) && entry!.total === null && !Object.values(entry!.items || {}).some((v) => v !== null)

  const itemsTotal = (items: Record<string, number | null>): number | null => {
    const values = itemColumns.map((item) => items[item.key]).filter((v): v is number => v !== null && v !== undefined)
    if (!values.length) return null
    return Number(values.reduce((sum, value) => sum + value, 0).toFixed(2))
  }

  const cellValue = (entry: ScoreEntry | undefined, column: string): string => {
    if (!entry) return ''
    if (column === Column.total) return entry.total === null ? '' : String(entry.total)
    const value = entry.items?.[column]
    return value === null || value === undefined ? '' : String(value)
  }

  const writeCell = (studentId: string, column: string, raw: string, prev?: Record<string, ScoreEntry>) => {
    if (!selectedExam) return prev || {}
    const next = { ...(prev || scores) }
    const entry: ScoreEntry = next[studentId]
      ? { total: next[studentId].total, items: { ...next[studentId].items } }
      : { total: null, items: {} }
    const full = column === Column.total ? selectedExam.full_score : itemColumns.find((item) => item.key === column)?.full || 0
    const parsed = raw.trim() === '' ? null : parseScoreCell(raw)
    const value = parsed === null ? null : Math.max(0, Math.min(full, parsed))
    if (column === Column.total) {
      // An itemised paper's total is the sum of its parts (the store recomputes
      // it on save), so a pasted total must not create a second version of it.
      if (itemColumns.length) return next
      entry.total = value
    } else {
      entry.items[column] = value
      entry.total = itemsTotal(entry.items)
    }
    next[studentId] = entry
    return next
  }

  const applyCell = (studentId: string, column: string, raw: string) => {
    setScores((prev) => writeCell(studentId, column, raw, prev))
  }

  const toggleAbsent = (studentId: string) => {
    setScores((prev) => {
      const next = { ...prev }
      if (next[studentId]) delete next[studentId]
      else next[studentId] = { total: null, items: {} }
      return next
    })
  }

  const focusCell = (row: number, column: number) => {
    const node = gridRef.current?.querySelector<HTMLInputElement>(
      `[data-cell="${row}-${column}"]`
    )
    node?.focus()
    node?.select()
  }

  const onCellKey = (e: React.KeyboardEvent<HTMLInputElement>, row: number, column: number) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault()
      focusCell(row + 1, column)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusCell(row - 1, column)
    }
  }

  const onPasteAt = (e: React.ClipboardEvent<HTMLInputElement>, startRow: number, startColumn: number) => {
    const text = e.clipboardData.getData('text/plain')
    if (!/[\n\t]/.test(text)) return
    e.preventDefault()
    const block = parseScoreBlock(text)
    if (!block.length) return
    setScores((prev) => {
      let next = prev
      block.forEach((cells, rowOffset) => {
        const student = students[startRow + rowOffset]
        if (!student) return
        cells.forEach((cell, columnOffset) => {
          const column = columns[startColumn + columnOffset]
          if (!column) return
          next = writeCell(student.id, column, cell, next)
        })
      })
      return next
    })
  }

  const save = async () => {
    if (!selectedExam || !classId || saving) return
    setSaving(true)
    // The store replaces the exam's whole block, so send every recorded
    // student — including the other classes of a shared exam — and let a
    // student with no entry stay unrecorded.
    const payload: Record<string, ScoreEntry> = {}
    Object.entries(scores).forEach(([studentId, entry]) => {
      if (itemColumns.length) {
        const items: Record<string, number | null> = {}
        itemColumns.forEach((item) => {
          items[item.key] = entry.items?.[item.key] ?? null
        })
        payload[studentId] = { total: entry.total, items }
      } else {
        payload[studentId] = { total: entry.total, items: {} }
      }
    })
    try {
      await apiClient.saveTeachingScores(selectedExam.id, payload)
      setStatus(tf('tw_sc_saved', { n: Object.keys(payload).length }))
      // 分数变了：旧报告留在页面上，但下次进分析页会读到的是它自己那份。
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    } finally {
      setSaving(false)
    }
  }

  const saveExam = async (fields: ExamFields) => {
    if (dialog.target) await apiClient.updateTeachingExam(dialog.target.id, fields)
    else await apiClient.createTeachingExam(fields)
    setDialog({ open: false, target: null })
    setStatus(tf(dialog.target ? 'tw_sc_exam_saved' : 'tw_sc_exam_created', { name: fields.name || '' }))
    await load()
  }

  const deleteExam = async (exam: TeachingExam) => {
    const ok = await askConfirm({
      titleKey: 'tw_sc_exam_delete_title',
      msgKey: 'tw_sc_exam_delete_confirm',
      vars: { name: exam.name },
      okKey: 'tw_delete',
    })
    if (!ok) return
    try {
      await apiClient.deleteTeachingExam(exam.id)
      setStatus(tf('tw_sc_exam_deleted', { name: exam.name }))
      if (selectedExamId === exam.id) pickExam(undefined)
      await load()
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  const absentCount = useMemo(
    () => students.filter((student) => isAbsent(scores[student.id])).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [students, scores, itemColumns]
  )

  return (
    <div id="twb-scores" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head">
            <div>
              <h1>{t('tw_sc_title')}</h1>
              <p>{t('tw_sc_desc')}</p>
            </div>
            <div className="twb-head-controls">
              <button
                type="button"
                className="twb-btn twb-btn-primary"
                disabled={!classes.length}
                onClick={() => setDialog({ open: true, target: null })}
              >
                <Plus size={15} />
                <span>{t('tw_sc_exam_new')}</span>
              </button>
              <AiAssistButton
                pageKey="scores"
                dataFiles={['teaching/exams.json', 'teaching/scores.json']}
                scene={t('ai_scene_scores')}
              />
            </div>
          </header>

          <Status text={status} />

          {loading ? (
            <Loading />
          ) : error ? (
            <PageError message={error} onRetry={() => void load()} />
          ) : (
            <section className="twb-card twb-sc-main" aria-labelledby="twb-sc-main-title">
              {!selectedExam ? (
                <Empty icon={GraduationCap} text={t('tw_sc_pick_exam')} />
              ) : (
                <>
                  <div className="twb-card-head">
                    <div>
                      <h2 id="twb-sc-main-title">{selectedExam.name}</h2>
                      <p className="twb-hint">
                        {[
                          selectedExam.subject,
                          tf('tw_sc_full', { n: selectedExam.full_score }),
                          tf('tw_sc_absent_count', { n: absentCount }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <div className="twb-sc-head-tools">
                      <span className="twb-sc-exam-tools">
                      <button
                        type="button"
                        className="twb-icon-btn"
                        title={t('tw_sc_exam_edit')}
                        aria-label={t('tw_sc_exam_edit')}
                        onClick={() => setDialog({ open: true, target: selectedExam })}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="twb-icon-btn is-danger"
                        title={t('tw_delete')}
                        aria-label={t('tw_delete')}
                        onClick={() => void deleteExam(selectedExam)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                    <div className="twb-segs twb-segs-sm" role="tablist" aria-label={t('tw_sc_title')}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={view === 'entry'}
                        className="twb-seg"
                        onClick={() => setView('entry')}
                      >
                        {t('tw_sc_entry')}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={view === 'analysis'}
                        className="twb-seg"
                        onClick={() => setView('analysis')}
                      >
                        {t('tw_sc_analysis')}
                      </button>
                      </div>
                    </div>
                  </div>

                  {/* 筛选都在上方：考试、班级、学科。左侧栏曾占近 300px，
                      而考试与班级通常只有几条。 */}
                  <div className="twb-filter-bar">
                    <label className="twb-filter-field">
                      <span className="twb-filter-label">{t('tw_sc_exam_list')}</span>
                      <select
                        className="twb-filter-select"
                        value={selectedExamId}
                        onChange={(e) => {
                          const next = exams.find((exam) => exam.id === e.target.value)
                          if (next) pickExam(next)
                        }}
                      >
                        {exams.map((exam) => (
                          <option key={exam.id} value={exam.id}>
                            {[exam.name, exam.subject, exam.date].filter(Boolean).join(' · ')}
                          </option>
                        ))}
                      </select>
                    </label>

                    {selectedExam.class_ids.length > 1 && (
                      <div className="twb-filter-chips" role="group" aria-label={t('tw_sc_classes')}>
                        {selectedExam.class_ids.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className={`twb-chip${id === classId ? ' is-on' : ''}`}
                            aria-pressed={id === classId}
                            onClick={() => setClassId(id)}
                          >
                            {classes.find((item) => item.id === id)?.name || id}
                          </button>
                        ))}
                      </div>
                    )}

                    {view === 'entry' && itemColumns.length > 1 && (
                      <div className="twb-filter-chips" role="group" aria-label={t('tw_sc_subject_filter')}>
                        <button
                          type="button"
                          className={`twb-chip${subjectKeys === null ? ' is-on' : ''}`}
                          aria-pressed={subjectKeys === null}
                          onClick={() => setSubjectKeys(null)}
                        >
                          {t('tw_sc_all_subjects')}
                        </button>
                        {itemColumns.map((item) => {
                          const on = subjectKeys !== null && subjectKeys.includes(item.key)
                          return (
                            <button
                              key={item.key}
                              type="button"
                              className={`twb-chip${on ? ' is-on' : ''}`}
                              aria-pressed={on}
                              onClick={() => toggleSubject(item.key)}
                            >
                              {item.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {view === 'entry' ? (
                    scoresLoading ? (
                      <Loading />
                    ) : scoresError ? (
                      <PageError message={scoresError} onRetry={() => setSelectedExamId(selectedExam.id)} />
                    ) : students.length ? (
                      <>
                        <div className="twb-table-wrap" ref={gridRef}>
                          <table className="twb-table twb-score-table">
                            <thead>
                              <tr>
                                <th className="twb-col-no">{t('tw_sc_seq')}</th>
                                <th className="twb-col-name">{sortHeader('name', t('tw_st_name'))}</th>
                                <th className="twb-col-rank">{sortHeader('rank', t('tw_sc_rank'))}</th>
                                {shownItems.map((item) => (
                                  <th key={item.key} className="twb-col-score">
                                    {sortHeader(item.key, item.label)}
                                    <small>/{item.full}</small>
                                  </th>
                                ))}
                                {showTotal && (
                                  <th className="twb-col-total">
                                    {sortHeader(Column.total, t('tw_sc_total'))}
                                    <small>/{selectedExam.full_score}</small>
                                  </th>
                                )}
                                <th className="twb-col-absent">{t('tw_sc_absent')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((student, row) => {
                                const entry = scores[student.id]
                                const absent = isAbsent(entry)
                                return (
                                  <tr key={student.id} className={absent ? 'is-absent' : ''}>
                                    {/* 序号跟着当前行序走（排序后重新从 1 开始），
                                        学号不在成绩表里展示。 */}
                                    <td className="is-num twb-seq-cell">{row + 1}</td>
                                    <td>{student.name}</td>
                                    <td className="is-num twb-rank-cell">
                                      {absent ? '—' : rankByStudent.get(student.id) ?? '—'}
                                    </td>
                                    {shownItems.map((item, column) => (
                                      <td key={item.key} className="is-num is-cell">
                                        <input
                                          className="twb-score-input"
                                          type="number"
                                          min={0}
                                          max={item.full}
                                          data-cell={`${row}-${column}`}
                                          disabled={absent}
                                          value={cellValue(entry, item.key)}
                                          onChange={(e) => applyCell(student.id, item.key, e.target.value)}
                                          onKeyDown={(e) => onCellKey(e, row, column)}
                                          onPaste={(e) => onPasteAt(e, row, column)}
                                        />
                                      </td>
                                    ))}
                                    {showTotal && (
                                      <td className="is-num is-cell">
                                        <input
                                          className="twb-score-input twb-score-total"
                                          type="number"
                                          min={0}
                                          max={selectedExam.full_score}
                                          data-cell={`${row}-${columns.length - 1}`}
                                          disabled={absent}
                                          readOnly={itemColumns.length > 0}
                                          value={cellValue(entry, Column.total)}
                                          onChange={(e) =>
                                            applyCell(student.id, Column.total, e.target.value)
                                          }
                                          onKeyDown={(e) => onCellKey(e, row, columns.length - 1)}
                                          onPaste={(e) => onPasteAt(e, row, columns.length - 1)}
                                        />
                                      </td>
                                    )}
                                    <td>
                                      <button
                                        type="button"
                                        className={`twb-chip${absent ? ' is-on' : ''}`}
                                        aria-pressed={absent}
                                        onClick={() => toggleAbsent(student.id)}
                                      >
                                        {absent ? t('tw_sc_absent') : t('tw_sc_mark_absent')}
                                      </button>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                        <div className="twb-form-actions">
                          <button
                            type="button"
                            className="twb-btn twb-btn-primary"
                            disabled={saving}
                            onClick={() => void save()}
                          >
                            {t('tw_sc_save')}
                          </button>
                          <span className="twb-hint">{t('tw_sc_entry_hint')}</span>
                        </div>
                      </>
                    ) : (
                      <Empty icon={GraduationCap} text={t('tw_sc_no_students')} />
                    )
                  ) : (
                    <div className="twb-analysis">
                      {/* 分析页就是这份 AI 报告：数字由后端算、前端只负责画图，
                          模型写解读。报告与考试绑定，可随时重新生成。 */}
                      <section className="twb-report" aria-labelledby="twb-report-title">
                        <div className="twb-report-head">
                          <div className="twb-report-title">
                            <span className="twb-report-icon">
                              <Sparkles size={15} />
                            </span>
                            <h3 id="twb-report-title">{t('tw_an_ai_title')}</h3>
                            {report?.generated_at && !reportGenerating && (
                              <span className="twb-report-meta">
                                {tf('tw_an_ai_updated', {
                                  t: report.generated_at.replace('T', ' ').slice(0, 16),
                                })}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="twb-btn twb-btn-primary"
                            disabled={reportGenerating}
                            onClick={() => void generateReport()}
                          >
                            {reportGenerating ? (
                              <Loader2 size={14} className="twb-spin" />
                            ) : (
                              <Sparkles size={14} />
                            )}
                            <span>
                              {report?.markdown ? t('tw_an_ai_regenerate') : t('tw_an_ai_generate')}
                            </span>
                          </button>
                        </div>

                        {reportGenerating ? (
                          <div className="twb-report-skeleton" aria-busy="true">
                            <span /><span /><span /><span />
                            <p>{t('tw_an_ai_generating')}</p>
                          </div>
                        ) : report?.markdown ? (
                          <>
                            <ReportVisuals facts={report.facts} />
                            <div className="twb-report-body">
                              <Markdown content={report.markdown} />
                            </div>
                          </>
                        ) : (
                          <p className="twb-report-empty">{reportError || t('tw_an_ai_empty')}</p>
                        )}
                      </section>
                    </div>
                  )}

                </>
              )}
          </section>
          )}
        </div>
      </div>

      {dialog.open && (
        <ExamDialog
          initial={dialog.target}
          classes={classes}
          onClose={() => setDialog({ open: false, target: null })}
          onSubmit={saveExam}
        />
      )}
    </div>
  )
}

export default ScoresPage
