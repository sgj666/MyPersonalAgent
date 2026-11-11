import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChartLine, GraduationCap, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
import type {
  AnalysisTrendPoint,
  ExamFields,
  ExamItem,
  ScoreEntry,
  TeachingAnalysis,
  TeachingClass,
  TeachingExam,
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

/** 学生历次趋势: a small inline line over the student's totals. */
const TrendChart: React.FC<{ points: AnalysisTrendPoint[] }> = ({ points }) => {
  const values = points
    .map((point) => point.total)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  if (values.length < 2) {
    return <span className="twb-trend-empty">{points.length ? wholeText(values[0]) : '—'}</span>
  }
  const width = 120
  const height = 30
  const pad = 4
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const coords = points.map((point, index) => {
    if (point.total === null) return ''
    const x = pad + (index * (width - pad * 2)) / (points.length - 1)
    const y = height - pad - ((point.total - min) / span) * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg className="twb-trend" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
      <polyline points={coords.join(' ')} fill="none" stroke="var(--twb-accent)" strokeWidth={2} />
      {coords.map((coord, index) =>
        coord ? (
          <circle
            key={`${index}-${coord}`}
            cx={coord.split(',')[0]}
            cy={coord.split(',')[1]}
            r={2.5}
            fill="var(--twb-accent)"
          />
        ) : null
      )}
    </svg>
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
  const [analysis, setAnalysis] = useState<TeachingAnalysis | null>(null)
  const [analysisKey, setAnalysisKey] = useState('')
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [dialog, setDialog] = useState<{ open: boolean; target: TeachingExam | null }>({
    open: false,
    target: null,
  })
  const gridRef = useRef<HTMLDivElement>(null)
  const scoreToken = useRef(0)
  const studentToken = useRef(0)

  const selectedExam = exams.find((exam) => exam.id === selectedExamId) || null

  const pickExam = (exam: TeachingExam | undefined) => {
    setSelectedExamId(exam?.id || '')
    setClassId(exam?.class_ids[0] || '')
    setAnalysis(null)
    setAnalysisKey('')
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

  // The report spans every class of the exam, so the parallel-class table is
  // real rather than a single row of the class the entry grid happens to show.
  useEffect(() => {
    if (view !== 'analysis' || !selectedExam) return
    const key = selectedExam.id
    if (analysisKey === key) return
    let cancelled = false
    setAnalysisLoading(true)
    setAnalysisError('')
    apiClient
      .getTeachingAnalysis(selectedExam.id)
      .then((data) => {
        if (cancelled) return
        setAnalysis(data)
        setAnalysisKey(key)
      })
      .catch((err) => {
        if (!cancelled) setAnalysisError(errorText(err))
      })
      .finally(() => {
        if (!cancelled) setAnalysisLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, selectedExam, analysisKey])

  const itemColumns = selectedExam?.items || []
  const columns = itemColumns.length
    ? [...itemColumns.map((item) => item.key), Column.total]
    : [Column.total]

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
      setAnalysisKey('')
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

  const classExams = selectedExam ? exams : []

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
            </div>
          </header>

          <Status text={status} />

          {loading ? (
            <Loading />
          ) : error ? (
            <PageError message={error} onRetry={() => void load()} />
          ) : (
            <div className="twb-split">
              <aside className="twb-card twb-side">
                <div className="twb-card-head">
                  <h2>{t('tw_sc_exam_list')}</h2>
                  <span className="twb-count">{exams.length}</span>
                </div>
                {classExams.length ? (
                  <ul className="twb-side-list">
                    {classExams.map((exam) => (
                      <li key={exam.id}>
                        <button
                          type="button"
                          className={`twb-side-item${exam.id === selectedExamId ? ' is-active' : ''}`}
                          onClick={() => pickExam(exam)}
                        >
                          <b>{exam.name}</b>
                          <small>
                            {[exam.subject, exam.date].filter(Boolean).join(' · ')}
                          </small>
                          <small>
                            {exam.class_ids
                              .map((id) => classes.find((row) => row.id === id)?.name || '')
                              .filter(Boolean)
                              .join('、')}
                          </small>
                        </button>
                        <span className="twb-side-actions">
                          <button
                            type="button"
                            className="twb-icon-btn"
                            title={t('tw_sc_exam_edit')}
                            aria-label={t('tw_sc_exam_edit')}
                            onClick={() => setDialog({ open: true, target: exam })}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            className="twb-icon-btn is-danger"
                            title={t('tw_delete')}
                            aria-label={t('tw_delete')}
                            onClick={() => void deleteExam(exam)}
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty
                    icon={GraduationCap}
                    text={t('tw_sc_exam_empty')}
                    actionLabel={classes.length ? t('tw_sc_exam_new') : undefined}
                    onAction={() => setDialog({ open: true, target: null })}
                  />
                )}
              </aside>

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

                    {selectedExam.class_ids.length > 1 && (
                      <div className="twb-segs twb-segs-sm" role="tablist" aria-label={t('tw_sc_classes')}>
                        {selectedExam.class_ids.map((id) => (
                          <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={id === classId}
                            className="twb-seg"
                            onClick={() => setClassId(id)}
                          >
                            {classes.find((item) => item.id === id)?.name || id}
                          </button>
                        ))}
                      </div>
                    )}

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
                                  <th>{t('tw_st_no')}</th>
                                  <th>{t('tw_st_name')}</th>
                                  {itemColumns.map((item) => (
                                    <th key={item.key} className="is-num">
                                      {item.label}
                                      <small>/{item.full}</small>
                                    </th>
                                  ))}
                                  <th className="is-num">
                                    {t('tw_sc_total')}
                                    <small>/{selectedExam.full_score}</small>
                                  </th>
                                  <th>{t('tw_sc_absent')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {students.map((student, row) => {
                                  const entry = scores[student.id]
                                  const absent = isAbsent(entry)
                                  return (
                                    <tr key={student.id} className={absent ? 'is-absent' : ''}>
                                      <td className="is-num">{student.no}</td>
                                      <td>{student.name}</td>
                                      {itemColumns.map((item, column) => (
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
                    ) : analysisLoading ? (
                      <Loading />
                    ) : analysisError ? (
                      <PageError
                        message={analysisError}
                        onRetry={() => {
                          setAnalysis(null)
                          setAnalysisKey('')
                        }}
                      />
                    ) : analysis ? (
                      <div className="twb-analysis">
                        <div className="twb-stats">
                          <div className="twb-stat">
                            <span>{t('tw_an_count')}</span>
                            <b>{analysis.summary.scored}</b>
                            <small>{tf('tw_an_absent_n', { n: analysis.summary.absent })}</small>
                          </div>
                          <div className="twb-stat">
                            <span>{t('tw_an_average')}</span>
                            <b>{numberText(analysis.summary.average)}</b>
                          </div>
                          <div className="twb-stat">
                            <span>{t('tw_an_pass')}</span>
                            <b>{percentText(analysis.summary.pass_rate)}</b>
                          </div>
                          <div className="twb-stat">
                            <span>{t('tw_an_excellent')}</span>
                            <b>{percentText(analysis.summary.excellent_rate)}</b>
                          </div>
                          <div className="twb-stat">
                            <span>{t('tw_an_stddev')}</span>
                            <b>{numberText(analysis.summary.stddev, 2)}</b>
                          </div>
                        </div>

                        {analysis.by_class.length > 1 && (
                          <div className="twb-an-block">
                            <h3>{t('tw_an_by_class')}</h3>
                            <table className="twb-table">
                              <thead>
                                <tr>
                                  <th>{t('tw_an_class')}</th>
                                  <th className="is-num">{t('tw_an_count')}</th>
                                  <th className="is-num">{t('tw_an_average')}</th>
                                  <th className="is-num">{t('tw_an_pass')}</th>
                                  <th className="is-num">{t('tw_an_excellent')}</th>
                                  <th className="is-num">{t('tw_an_stddev')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {analysis.by_class.map((row) => (
                                  <tr key={row.class_id}>
                                    <td>{row.class_name}</td>
                                    <td className="is-num">{row.students}</td>
                                    <td className="is-num">{numberText(row.average)}</td>
                                    <td className="is-num">{percentText(row.pass_rate)}</td>
                                    <td className="is-num">{percentText(row.excellent_rate)}</td>
                                    <td className="is-num">{numberText(row.stddev, 2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {analysis.items.length > 0 && (
                          <div className="twb-an-block">
                            <h3>{t('tw_an_items')}</h3>
                            <table className="twb-table">
                              <thead>
                                <tr>
                                  <th>{t('tw_sc_item_label')}</th>
                                  <th className="is-num">{t('tw_an_full')}</th>
                                  <th className="is-num">{t('tw_an_average')}</th>
                                  <th>{t('tw_an_rate')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {analysis.items.map((item) => (
                                  <tr key={item.key}>
                                    <td>{item.label}</td>
                                    <td className="is-num">{wholeText(item.full)}</td>
                                    <td className="is-num">{numberText(item.average)}</td>
                                    <td>
                                      <div className="twb-progress-bar">
                                        <i style={{ width: `${Math.round(Math.min(100, item.rate ?? 0))}%` }} />
                                      </div>
                                      <small className="twb-hint">{percentText(item.rate)}</small>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div className="twb-an-block">
                          <h3>{t('tw_an_critical')}</h3>
                          {analysis.critical.length ? (
                            <ul className="twb-critical">
                              {analysis.critical.map((row) => (
                                <li key={row.student_id}>
                                  <b>{row.name}</b>
                                  <span>
                                    {row.class_name}
                                    {' · '}
                                    {wholeText(row.total)}
                                    {' · '}
                                    {tf('tw_an_gap', { n: numberText(row.gap) })}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="twb-hint">{t('tw_an_no_critical')}</p>
                          )}
                        </div>

                        <div className="twb-an-block">
                          <h3>{t('tw_an_trend')}</h3>
                          {analysis.students.length ? (
                            <div className="twb-table-wrap">
                              <table className="twb-table">
                                <thead>
                                  <tr>
                                    <th>{t('tw_st_name')}</th>
                                    <th>{t('tw_an_class')}</th>
                                    <th>{t('tw_an_trend')}</th>
                                    <th className="is-num">{t('tw_sc_total')}</th>
                                    <th className="is-num">{t('tw_an_delta')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {analysis.students.map((student) => {
                                    // The backend sends each student's whole
                                    // subject series; compare the last two
                                    // sittings that produced a total.
                                    const scored = student.exams.filter(
                                      (point) => point.total !== null
                                    )
                                    const first = scored[scored.length - 2]
                                    const second = scored[scored.length - 1]
                                    const delta =
                                      first && second && first.total !== null && second.total !== null
                                        ? second.total - first.total
                                        : null
                                    return (
                                      <tr key={student.student_id}>
                                        <td>{student.name}</td>
                                        <td>{student.class_name}</td>
                                        <td>
                                          <TrendChart points={student.exams} />
                                        </td>
                                        <td className="is-num">{wholeText(student.total)}</td>
                                        <td className="is-num">
                                          {delta === null
                                            ? '—'
                                            : `${delta > 0 ? '+' : ''}${numberText(delta)}`}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <p className="twb-hint">{t('tw_an_no_students')}</p>
                          )}
                        </div>

                        <button
                          type="button"
                          className="twb-btn"
                          onClick={() => {
                            setAnalysis(null)
                            setAnalysisKey('')
                          }}
                        >
                          <RefreshCw size={14} />
                          <span>{t('tw_an_refresh')}</span>
                        </button>
                      </div>
                    ) : (
                      <Empty icon={ChartLine} text={t('tw_an_empty')} />
                    )}
                  </>
                )}
              </section>
            </div>
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
