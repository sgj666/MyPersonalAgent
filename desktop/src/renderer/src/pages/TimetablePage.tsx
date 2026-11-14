import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Plus, Printer, Settings2, Trash2, X } from 'lucide-react'
import { t, tf } from '../i18n'
import apiClient from '../api/client'
import { useNavigate } from 'react-router-dom'
import {
  DEFAULT_PERIODS,
  TIMETABLE_KINDS,
  WEEKDAYS,
  errorText,
  todayISO,
  weekdayLabel,
  weekdayOf,
} from '../lib/teaching'
import { Empty, Loading, Modal, PageError, Status } from './teachingShared'
import AiAssistButton from '../components/AiAssistButton'
import type {
  TeachingClass,
  TeachingTimetable,
  TimetableKind,
  TimetableOverride,
  TimetablePeriod,
  TimetableSlot,
} from '../types'

interface TimetablePageProps {
  baseUrl: string
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const kindLabel = (kind: TimetableKind) => t(`tw_kind_${kind}`)

/**
 * One cell's editor. In fixed mode it changes the recurring slot; with a date
 * chosen it writes a one-off override (a swap or a cancellation) and leaves the
 * fixed table alone — §4: 一次调课或停课不改固定表.
 */
const CellDialog: React.FC<{
  weekday: number
  period: TimetablePeriod
  date: string
  slot: TimetableSlot | undefined
  override: TimetableOverride | undefined
  classes: TeachingClass[]
  onClose: () => void
  onSaveSlot: (slot: TimetableSlot | null) => void
  onSaveOverride: (override: TimetableOverride | null) => void
}> = ({ weekday, period, date, slot, override, classes, onClose, onSaveSlot, onSaveOverride }) => {
  const initialClass = override?.class_id || slot?.class_id || classes[0]?.id || ''
  const classOf = (id: string) => classes.find((item) => item.id === id)
  const [classId, setClassId] = useState(initialClass)
  const [subject, setSubject] = useState(
    override?.subject || slot?.subject || classOf(initialClass)?.subject || ''
  )
  const [kind, setKind] = useState<TimetableKind>(override?.kind || slot?.kind || 'regular')
  // §7.1: a slot is mine by default; only mine slots raise a lesson reminder.
  const [mine, setMine] = useState(slot?.mine !== false)
  const [error, setError] = useState('')
  const dayMode = Boolean(date)

  const pickClass = (id: string) => {
    setClassId(id)
    // The class carries its subject; only fill it when the field is blank, so
    // a typed subject is not overwritten by a class change.
    if (!subject.trim()) setSubject(classOf(id)?.subject || '')
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!classId) {
      setError(t('tw_tt_pick_class'))
      return
    }
    if (dayMode) {
      onSaveOverride({
        date,
        period: period.index,
        class_id: classId,
        subject: subject.trim() || classOf(classId)?.subject || '',
        kind,
        state: 'changed',
      })
    } else {
      onSaveSlot({
        id: slot?.id || newId('slot'),
        class_id: classId,
        weekday,
        period: period.index,
        subject: subject.trim() || classOf(classId)?.subject || '',
        kind,
        mine,
        // Display-only attribution the editor does not edit: keep it.
        ...(slot?.teacher ? { teacher: slot.teacher } : {}),
      })
    }
  }

  const cancelLesson = () => {
    if (!dayMode) return
    if (override?.state === 'cancelled') {
      onSaveOverride(null)
      return
    }
    onSaveOverride({
      date,
      period: period.index,
      class_id: classId,
      subject: subject.trim() || classOf(classId)?.subject || '',
      kind,
      state: 'cancelled',
    })
  }

  return (
    <Modal
      titleId="twb-cell-title"
      title={tf(dayMode ? 'tw_tt_cell_override_title' : 'tw_tt_cell_title', {
        day: t(weekdayLabel(weekday)),
        period: period.index,
      })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="twb-btn" onClick={onClose}>
            {t('tw_cancel')}
          </button>
          {dayMode ? (
            <button type="button" className="twb-btn" onClick={cancelLesson}>
              {override?.state === 'cancelled' ? t('tw_tt_undo_cancel') : t('tw_tt_cancel_lesson')}
            </button>
          ) : (
            <button
              type="button"
              className="twb-btn twb-btn-danger"
              disabled={!slot}
              onClick={() => onSaveSlot(null)}
            >
              <Trash2 size={14} />
              <span>{t('tw_tt_clear')}</span>
            </button>
          )}
          <button type="submit" form="twb-cell-form" className="twb-btn twb-btn-primary">
            {t('tw_save')}
          </button>
        </>
      }
    >
      <form id="twb-cell-form" className="twb-form-body" onSubmit={submit}>
        {dayMode && <p className="twb-hint">{tf('tw_tt_override_hint', { date })}</p>}
        <label className="twb-field">
          <span>{t('tw_tt_class')}</span>
          <select className="twb-select" value={classId} onChange={(e) => pickClass(e.target.value)}>
            {classes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="twb-field-row">
          <label className="twb-field">
            <span>{t('tw_tt_subject')}</span>
            <input
              className="twb-input"
              type="text"
              maxLength={20}
              value={subject}
              placeholder={classOf(classId)?.subject || t('tw_tt_subject_ph')}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label className="twb-field">
            <span>{t('tw_tt_kind')}</span>
            <select
              className="twb-select"
              value={kind}
              onChange={(e) => setKind(e.target.value as TimetableKind)}
            >
              {TIMETABLE_KINDS.map((item) => (
                <option key={item} value={item}>
                  {kindLabel(item)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!dayMode && (
          <>
            <label className="twb-check">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              <span>{t('tw_tt_mine_check')}</span>
            </label>
            <p className="twb-hint">{t('tw_tt_mine_hint')}</p>
          </>
        )}
        {dayMode && override && (
          <button
            type="button"
            className="twb-link"
            onClick={() => onSaveOverride(null)}
          >
            <X size={13} />
            <span>{t('tw_tt_clear_override')}</span>
          </button>
        )}
        {error && <p className="twb-status is-error">{error}</p>}
      </form>
    </Modal>
  )
}

/** The day's period times; removing one also removes that period's slots. */
const PeriodsDialog: React.FC<{
  periods: TimetablePeriod[]
  onClose: () => void
  onSave: (periods: TimetablePeriod[]) => void
}> = ({ periods, onClose, onSave }) => {
  const [rows, setRows] = useState<TimetablePeriod[]>(periods.map((row) => ({ ...row })))
  const set = (index: number, key: 'start' | 'end', value: string) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)))
  return (
    <Modal
      titleId="twb-periods-title"
      title={t('tw_tt_periods')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="twb-btn" onClick={onClose}>
            {t('tw_cancel')}
          </button>
          <button
            type="button"
            className="twb-btn twb-btn-primary"
            onClick={() => {
              const kept = rows
                .filter((row) => row.start || row.end)
                .sort((a, b) => a.index - b.index)
              onSave(kept.length ? kept : DEFAULT_PERIODS)
            }}
          >
            {t('tw_save')}
          </button>
        </>
      }
    >
      <div className="twb-form-body">
        <p className="twb-hint">{t('tw_tt_periods_hint')}</p>
        <div className="twb-periods">
          {rows.map((row, i) => (
            <div className="twb-period-row" key={row.index}>
              <span className="twb-period-no">{tf('tw_tt_period_n', { n: row.index })}</span>
              <input
                className="twb-input"
                type="time"
                value={row.start}
                onChange={(e) => set(i, 'start', e.target.value)}
              />
              <span>–</span>
              <input
                className="twb-input"
                type="time"
                value={row.end}
                onChange={(e) => set(i, 'end', e.target.value)}
              />
              <button
                type="button"
                className="twb-icon-btn is-danger"
                aria-label={t('tw_delete')}
                onClick={() => setRows((prev) => prev.filter((_, at) => at !== i))}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="twb-btn"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              { index: prev.reduce((max, row) => Math.max(max, row.index), 0) + 1, start: '', end: '' },
            ])
          }
        >
          <Plus size={14} />
          <span>{t('tw_tt_add_period')}</span>
        </button>
      </div>
    </Modal>
  )
}

const TimetablePage: React.FC<TimetablePageProps> = ({ baseUrl }) => {
  const navigate = useNavigate()
  const [classes, setClasses] = useState<TeachingClass[]>([])
  const [table, setTable] = useState<TeachingTimetable>({ periods: [], slots: [], overrides: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [date, setDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [cell, setCell] = useState<{ weekday: number; period: TimetablePeriod } | null>(null)
  const [periodsOpen, setPeriodsOpen] = useState(false)
  // Toolbar filter (§7.4): show only the teacher's own lessons.
  const [mineOnly, setMineOnly] = useState(false)
  const saving = useRef(false)

  const load = useCallback(async () => {
    apiClient.setBaseUrl(baseUrl)
    setError('')
    try {
      const [classRows, timetable] = await Promise.all([
        apiClient.listTeachingClasses(),
        apiClient.getTeachingTimetable(),
      ])
      setClasses(classRows)
      setTable(timetable)
      setLoading(false)
    } catch (err) {
      setError(errorText(err))
      setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  const periods = useMemo(() => {
    const rows = (table.periods.length ? table.periods : DEFAULT_PERIODS).slice()
    return rows.sort((a, b) => a.index - b.index)
  }, [table.periods])

  const classById = useMemo(() => new Map(classes.map((item) => [item.id, item])), [classes])
  const classOf = (id: string) => classById.get(id)

  const slotAt = (weekday: number, period: number) =>
    table.slots.find((slot) => slot.weekday === weekday && slot.period === period)
  const overrideAt = (period: number) =>
    date ? table.overrides.find((item) => item.date === date && item.period === period) : undefined

  const save = async (next: TeachingTimetable, message: string) => {
    if (saving.current) return
    saving.current = true
    // A table that fell back to the built-in periods has never been saved;
    // persist them with the first edit so the slots and their times agree.
    const payload = next.periods.length ? next : { ...next, periods: DEFAULT_PERIODS }
    setTable(payload)
    setStatus(message)
    try {
      await apiClient.saveTeachingTimetable(payload)
      // §7.3: the table is what the lesson reminders are built from, so every
      // save re-lays them; the sync is idempotent. Report a failure rather
      // than letting the table look synced when it is not.
      await apiClient.syncTeachingReminders().catch((err) => {
        setStatus(tf('tw_tt_sync_failed', { msg: errorText(err) }))
      })
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
      await load()
    } finally {
      saving.current = false
    }
  }

  const saveSlot = (weekday: number, period: number, slot: TimetableSlot | null) => {
    setCell(null)
    const slots = slot
      ? [
          ...table.slots.filter((item) => !(item.weekday === weekday && item.period === period)),
          slot,
        ]
      : table.slots.filter((item) => !(item.weekday === weekday && item.period === period))
    void save(
      { ...table, slots },
      slot
        ? tf('tw_tt_slot_saved', {
            day: t(weekdayLabel(weekday)),
            period,
            name: classOf(slot.class_id)?.name || '',
          })
        : t('tw_tt_slot_cleared')
    )
  }

  const saveOverride = (period: number, override: TimetableOverride | null) => {
    setCell(null)
    const rest = table.overrides.filter((item) => !(item.date === date && item.period === period))
    void save(
      { ...table, overrides: override ? [...rest, override] : rest },
      override?.state === 'cancelled'
        ? t('tw_tt_lesson_cancelled')
        : override
          ? t('tw_tt_override_saved')
          : t('tw_tt_override_cleared')
    )
  }

  const stats = useMemo(() => {
    const byClass = new Map<string, Record<TimetableKind, number>>()
    let total = 0
    for (const slot of table.slots) {
      if (mineOnly && slot.mine === false) continue
      total++
      const row = byClass.get(slot.class_id) || ({} as Record<TimetableKind, number>)
      row[slot.kind] = (row[slot.kind] || 0) + 1
      byClass.set(slot.class_id, row)
    }
    return { total, byClass }
  }, [table.slots, mineOnly])

  const weekend = date !== '' && (weekdayOf(date) === 0 || weekdayOf(date) === 6)
  // A dated view edits ONE day. Showing all five columns on a date whose
  // weekday has no column (Saturday, Sunday) left every cell locked, so the
  // ＋ looked broken: nothing happened anywhere. Day mode therefore renders
  // only the column for `date`, and that column is always editable.
  const dayColumn = date ? (weekdayOf(date) === 0 ? 7 : weekdayOf(date)) : 0
  const columns = date ? [dayColumn] : WEEKDAYS

  return (
    <div id="twb-timetable" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head twb-tt-head">
            <div>
              <h1>{t('tw_tt_title')}</h1>
              <p>{t('tw_tt_desc')}</p>
            </div>
            <div className="twb-head-controls">
              <label className="twb-field twb-field-inline twb-tt-date">
                <span>{t('tw_tt_date')}</span>
                <input
                  className="twb-input"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              {date !== todayIso() && (
                <button type="button" className="twb-btn" onClick={() => setDate(todayIso())}>
                  <X size={14} />
                  <span>{t('tw_tt_back_today')}</span>
                </button>
              )}
              <label className="twb-check">
                <input
                  type="checkbox"
                  checked={mineOnly}
                  onChange={(e) => setMineOnly(e.target.checked)}
                />
                <span>{t('tw_tt_mine_only')}</span>
              </label>
              <button type="button" className="twb-btn" onClick={() => setPeriodsOpen(true)}>
                <Settings2 size={14} />
                <span>{t('tw_tt_periods')}</span>
              </button>
              <button type="button" className="twb-btn" onClick={() => window.print()}>
                <Printer size={14} />
                <span>{t('tw_tt_print')}</span>
              </button>
              <AiAssistButton
                pageKey="timetable"
                dataTool="timetable"
                scene={t('ai_scene_timetable')}
              />
            </div>
          </header>

          <Status text={status} />

          {loading ? (
            <Loading />
          ) : error ? (
            <PageError message={error} onRetry={() => void load()} />
          ) : (
            <>
              {!classes.length && (
                <p className="twb-hint">
                  {t('tw_tt_need_classes')}{' '}
                  <button type="button" className="twb-link" onClick={() => navigate('/classes')}>
                    {t('tw_classes_title')}
                  </button>
                </p>
              )}
              {weekend && <p className="twb-hint">{t('tw_tt_weekend')}</p>}
              <div className="twb-tt-layout">
                <section className="twb-card twb-tt-card" aria-labelledby="twb-tt-grid-title">
                  <div className="twb-card-head">
                    <h2 id="twb-tt-grid-title">
                      {date ? tf('tw_tt_grid_date', { date }) : t('tw_tt_grid_fixed')}
                    </h2>
                    <span className="twb-count">{stats.total}</span>
                  </div>
                  <div className="twb-table-wrap">
                  <div className="twb-tt-summary" aria-label={t('tw_tt_stats')}>
                    <span className="twb-tt-summary-label">{t('tw_tt_stats')}</span>
                    {classes.map((item) => {
                      const row = stats.byClass.get(item.id) || ({} as Record<TimetableKind, number>)
                      const total = TIMETABLE_KINDS.reduce((sum, kind) => sum + (row[kind] || 0), 0)
                      return (
                        <span key={item.id} className="twb-tt-chip">
                          <b>{item.name}</b>
                          <em>{tf('tw_tt_weekly', { n: total })}</em>
                          {TIMETABLE_KINDS.filter((kind) => row[kind]).map((kind) => (
                            <span key={kind} className={`twb-kind twb-kind-${kind}`}>
                              {kindLabel(kind)} {row[kind]}
                            </span>
                          ))}
                        </span>
                      )
                    })}
                    <span className="twb-tt-summary-hint">
                      {mineOnly ? t('tw_tt_stats_hint_mine') : t('tw_tt_stats_hint')}
                    </span>
                  </div>
                    <table className="twb-tt">
                      <thead>
                        <tr>
                          <th className="twb-tt-corner">{t('tw_tt_period')}</th>
                          {columns.map((weekday) => (
                            <th key={weekday}>
                              {t(weekdayLabel(weekday))}
                              {date && <small className="twb-tt-th-date"> {date.slice(5)}</small>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {periods.map((period) => (
                          <tr key={period.index}>
                            <th className="twb-tt-rowhead">
                              <b>{period.index}</b>
                              <small>
                                {period.start || '—'}
                                {period.end ? `–${period.end}` : ''}
                              </small>
                            </th>
                            {columns.map((weekday) => {
                              const slot = slotAt(weekday, period.index)
                              const override = date && weekdayOf(date) === weekday ? overrideAt(period.index) : undefined
                              const shownClass = classOf(override?.class_id || slot?.class_id || '')
                              // §7.1: a slot without the field is the teacher's own.
                              const mine = slot?.mine !== false
                              // The filter hides other teachers' lessons rather
                              // than blanking the grid: the cell keeps its place
                              // so the week still lines up, but it cannot be
                              // edited into a lesson while it is out of view.
                              if (mineOnly && slot && !mine) {
                                return (
                                  <td key={weekday}>
                                    <div className="twb-tt-cell is-others" title={t('tw_tt_other_hidden')}>
                                      <span className="twb-tt-add">·</span>
                                    </div>
                                  </td>
                                )
                              }
                              return (
                                <td key={weekday}>
                                  <button
                                    type="button"
                                    className={`twb-tt-cell${slot || override ? ' is-filled' : ''}${
                                      override?.state === 'cancelled' ? ' is-cancelled' : ''
                                    }${override ? ' is-override' : ''}${
                                      slot && !mine ? ' is-others' : ''
                                    }${
                                      date && weekdayOf(date) !== weekday ? ' is-locked' : ''
                                    }`}
                                    onClick={() => {
                                      // A dated edit belongs to that date's own
                                      // weekday column; recording it from another
                                      // column would save a row nobody can see.
                                      if (date && dayColumn !== weekday) {
                                        setStatus(t('tw_tt_wrong_day'))
                                        return
                                      }
                                      // Without a class there is nothing to put in
                                      // the cell: say so instead of opening a
                                      // dialog whose class list is empty.
                                      if (!classes.length) {
                                        setStatus(t('tw_tt_need_classes'))
                                        return
                                      }
                                      setCell({ weekday, period })
                                    }}
                                  >
                                    {slot && mine && override?.state !== 'cancelled' && (
                                      <i className="twb-tt-mine-dot" title={t('tw_tt_mine')} />
                                    )}
                                    {override?.state === 'cancelled' ? (
                                      <>
                                        <b>{t('tw_tt_cancelled')}</b>
                                        <small>{shownClass?.name || ''}</small>
                                      </>
                                    ) : shownClass || override ? (
                                      <>
                                        <b>{shownClass?.name || t('tw_tt_unknown_class')}</b>
                                        <small>
                                          {override?.subject || slot?.subject || shownClass?.subject || ''}
                                          {' · '}
                                          {kindLabel(override?.kind || slot?.kind || 'regular')}
                                        </small>
                                        {override && <em>{t('tw_tt_changed')}</em>}
                                      </>
                                    ) : (
                                      <span className="twb-tt-add">＋</span>
                                    )}
                                  </button>
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="twb-hint twb-tt-legend">
                    <i className="twb-tt-mine-dot" />
                    <span>{t('tw_tt_mine_legend')}</span>
                  </p>
                  <p className="twb-hint">
                    {date ? t('tw_tt_cell_hint_date') : t('tw_tt_cell_hint_fixed')}
                  </p>
                </section>

              </div>
            </>
          )}
        </div>
      </div>

      {cell && (
        <CellDialog
          weekday={cell.weekday}
          period={cell.period}
          date={date}
          slot={slotAt(cell.weekday, cell.period.index)}
          override={date && weekdayOf(date) === cell.weekday ? overrideAt(cell.period.index) : undefined}
          classes={classes}
          onClose={() => setCell(null)}
          onSaveSlot={(slot) => saveSlot(cell.weekday, cell.period.index, slot)}
          onSaveOverride={(override) => saveOverride(cell.period.index, override)}
        />
      )}

      {periodsOpen && (
        <PeriodsDialog
          periods={periods}
          onClose={() => setPeriodsOpen(false)}
          onSave={(next) => {
            setPeriodsOpen(false)
            const indexes = new Set(next.map((row) => row.index))
            void save(
              {
                ...table,
                periods: next,
                slots: table.slots.filter((slot) => indexes.has(slot.period)),
              },
              t('tw_tt_periods_saved')
            )
          }}
        />
      )}
    </div>
  )
}

export default TimetablePage
