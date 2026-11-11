import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { getLang, t, tf } from '../i18n'
import apiClient from '../api/client'
import { askConfirm } from '../store/confirmStore'
import type { BoardPriority, BoardSnapshot, BoardStatus, BoardTask } from '../types'

interface BoardPageProps {
  baseUrl: string
}

/** The four lanes are the board's shape, not a property of its contents. */
const STATUSES: BoardStatus[] = ['todo', 'doing', 'blocked', 'done']
/** The four quadrants, in the order they sort and render. */
const QUADRANTS: BoardPriority[] = ['urgent_important', 'important', 'urgent', 'neither']
const QUADRANT_ORDER: Record<BoardPriority, number> = {
  urgent_important: 0,
  important: 1,
  urgent: 2,
  neither: 3,
}
/** Lane filter value for tasks that have no lane of their own. */
const LANE_NONE = '__none__'
/** One-click categories; the field stays free text. */
const CATEGORY_SUGGESTIONS = ['备课', '批改', '班级', '教研', '家校', '其他']

type SortMode = 'due' | 'priority' | 'created'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar date, not ISO: a task is late by the teacher's day. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** UTC day number for a `YYYY-MM-DD`, so date arithmetic ignores DST. */
function dayNumber(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 86400000
}

/** `MM-DD HH:MM` in the reader's timezone; empty for a missing timestamp. */
function formatMoment(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** "今天 18:00", "明天", "9月2日 14:00" or the no-deadline label. */
function dueLabel(task: BoardTask, today: string, tomorrow: string): string {
  if (!task.due) return t('tw_task_none_due')
  let day: string
  if (task.due === today) day = t('tw_task_due_today')
  else if (task.due === tomorrow) day = t('tw_task_due_tomorrow')
  else {
    const [year, month, date] = task.due.split('-').map(Number)
    day = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(year, month - 1, date))
  }
  return task.due_time ? `${day} ${task.due_time}` : day
}

/**
 * Display order. `due` puts the nearest deadline first with undated tasks last,
 * `priority` walks the quadrants then the same due order inside each, and
 * `created` is newest first. Mirrors the backend's own `sort` modes.
 */
function sortTasks(rows: BoardTask[], mode: SortMode): BoardTask[] {
  const sorted = rows.slice()
  sorted.sort((a, b) => {
    if (mode === 'created') {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''))
    }
    const quadrantDiff =
      (QUADRANT_ORDER[a.priority] ?? QUADRANT_ORDER.important) -
      (QUADRANT_ORDER[b.priority] ?? QUADRANT_ORDER.important)
    if (mode === 'priority' && quadrantDiff !== 0) return quadrantDiff
    if (a.due !== b.due) {
      if (!a.due) return 1
      if (!b.due) return -1
      return a.due.localeCompare(b.due)
    }
    return String(b.created_at || '').localeCompare(String(a.created_at || ''))
  })
  return sorted
}

/**
 * Create/edit form. Mounted per task (keyed by id) so its fields start from the
 * task being edited without an effect to copy them in.
 */
const TaskDialog: React.FC<{
  task: BoardTask | null
  lanes: string[]
  defaultLane: string
  onClose: () => void
  onSaved: (text: string) => void
}> = ({ task, lanes, defaultLane, onClose, onSaved }) => {
  const [title, setTitle] = useState(task?.title || '')
  const [note, setNote] = useState(task?.note || '')
  const [lane, setLane] = useState(task ? task.lane : defaultLane)
  const [due, setDue] = useState(task?.due || '')
  const [dueTime, setDueTime] = useState(task?.due_time || '')
  const [category, setCategory] = useState(task?.category || '')
  const [status, setStatus] = useState<BoardStatus>(task?.status || 'todo')
  const [priority, setPriority] = useState<BoardPriority>(task?.priority || 'important')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const changeDue = (value: string) => {
    setDue(value)
    // A time without a date is not a deadline the backend accepts.
    if (!value) setDueTime('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    const cleanTitle = title.trim()
    if (!cleanTitle) {
      setError(t('tw_task_title_required'))
      return
    }
    setSaving(true)
    const fields = {
      title: cleanTitle,
      note: note.trim(),
      lane: lane.trim(),
      due,
      due_time: due ? dueTime : '',
      category: category.trim(),
      status,
      priority,
    }
    try {
      if (task) await apiClient.updateBoardTask(task.id, fields)
      else await apiClient.createBoardTask(fields)
      onSaved(tf(task ? 'tw_task_updated' : 'tw_task_created', { title: cleanTitle }))
    } catch (err) {
      setError(tf('tw_task_save_failed', { msg: message(err) }))
    } finally {
      setSaving(false)
    }
  }

  const createdAt = formatMoment(task?.created_at || '')
  const updatedAt = formatMoment(task?.updated_at || '')

  return (
    <div className="twb-modal">
      <div className="twb-modal-scrim" onClick={onClose} />
      <div className="twb-modal-card" role="dialog" aria-modal="true" aria-labelledby="twb-task-dialog-title">
        <div className="twb-modal-head">
          <h2 id="twb-task-dialog-title">{t(task ? 'tw_task_edit' : 'tw_board_new')}</h2>
          <button type="button" className="twb-icon-btn" onClick={onClose} aria-label={t('tw_cancel')}>
            <X size={14} />
          </button>
        </div>
        <form className="twb-form-body" onSubmit={submit}>
          <label className="twb-field">
            <span>{t('tw_task_title')}</span>
            <input
              className="twb-input"
              type="text"
              maxLength={120}
              required
              autoFocus
              value={title}
              placeholder={t('tw_task_title_ph')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="twb-field">
            <span>{t('tw_task_note')}</span>
            <textarea
              className="twb-textarea"
              rows={3}
              maxLength={2000}
              value={note}
              placeholder={t('tw_task_note_ph')}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="twb-field">
            <span>{t('tw_task_priority')}</span>
            <div className="twb-quad-picker" role="group" aria-label={t('tw_task_priority')}>
              {QUADRANTS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`twb-chip twb-quad twb-quad-${item}${priority === item ? ' is-on' : ''}`}
                  aria-pressed={priority === item}
                  onClick={() => setPriority(item)}
                >
                  {t(`tw_priority_${item}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="twb-field-row">
            <label className="twb-field">
              <span>{t('tw_task_due_label')}</span>
              <input
                className="twb-input"
                type="date"
                value={due}
                onChange={(e) => changeDue(e.target.value)}
              />
            </label>
            <label className="twb-field">
              <span>{t('tw_task_due_time')}</span>
              <input
                className="twb-input"
                type="time"
                value={dueTime}
                disabled={!due}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </label>
          </div>
          <label className="twb-field">
            <span>{t('tw_task_category')}</span>
            <input
              className="twb-input"
              type="text"
              maxLength={20}
              list="twb-category-options"
              value={category}
              placeholder={t('tw_task_category_ph')}
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="twb-category-options">
              {CATEGORY_SUGGESTIONS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
          <div className="twb-field-row">
            <label className="twb-field">
              <span>{t('tw_task_status')}</span>
              <select
                className="twb-select"
                value={status}
                onChange={(e) => setStatus(e.target.value as BoardStatus)}
              >
                {STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {t(`tw_status_${item}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="twb-field">
              <span>{t('tw_board_lane')}</span>
              <input
                className="twb-input"
                type="text"
                maxLength={40}
                list="twb-lane-options"
                value={lane}
                onChange={(e) => setLane(e.target.value)}
              />
              <datalist id="twb-lane-options">
                {lanes.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
          </div>
          {task && (createdAt || updatedAt) && (
            <p className="twb-task-times">
              {createdAt && <span>{tf('tw_task_created_at', { time: createdAt })}</span>}
              {updatedAt && <span>{tf('tw_task_updated_at', { time: updatedAt })}</span>}
            </p>
          )}
          {error && (
            <p className="twb-status is-error" role="status">
              {error}
            </p>
          )}
          <div className="twb-modal-actions">
            <button type="button" className="twb-btn" onClick={onClose}>
              {t('tw_cancel')}
            </button>
            <button type="submit" className="twb-btn twb-btn-primary" disabled={saving}>
              {t('tw_save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const BoardPage: React.FC<BoardPageProps> = ({ baseUrl }) => {
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [board, setBoard] = useState<BoardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' })
  const [laneFilter, setLaneFilter] = useState('')
  const [quadrantFilter, setQuadrantFilter] = useState<BoardPriority | ''>('')
  const [sortMode, setSortMode] = useState<SortMode>('due')
  const [dialog, setDialog] = useState<{ open: boolean; task: BoardTask | null }>({ open: false, task: null })
  const [draggingId, setDraggingId] = useState('')
  const [dropStatus, setDropStatus] = useState<BoardStatus | null>(null)
  const loadToken = useRef(0)
  // One move at a time: a second drop while the first is in flight would race
  // the reload that follows it.
  const saving = useRef(false)
  const lanesRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const token = ++loadToken.current
    apiClient.setBaseUrl(baseUrl)
    try {
      const data = await apiClient.getBoard()
      if (token !== loadToken.current) return
      setTasks(Array.isArray(data.tasks) ? data.tasks : [])
      setBoard(data.board || null)
    } catch (err) {
      if (token !== loadToken.current) return
      setStatus({ text: `${t('tw_load_failed')} — ${message(err)}`, error: true })
    } finally {
      if (token === loadToken.current) setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  // Lanes come from the tasks themselves; a board with only laneless work
  // still offers the "no lane" choice in the filter.
  const { lanes, loose } = useMemo(() => {
    const seen = new Set<string>()
    let hasLoose = false
    tasks.forEach((task) => {
      if (task.lane) seen.add(task.lane)
      else hasLoose = true
    })
    return { lanes: [...seen].sort((a, b) => a.localeCompare(b, 'zh')), loose: hasLoose }
  }, [tasks])

  // The chosen lane can disappear when its last task is deleted or re-laned.
  useEffect(() => {
    if (laneFilter === LANE_NONE && !loose) setLaneFilter('')
    else if (laneFilter && laneFilter !== LANE_NONE && !lanes.includes(laneFilter)) setLaneFilter('')
  }, [laneFilter, lanes, loose])

  const visible = useMemo(() => {
    let rows = tasks
    if (laneFilter === LANE_NONE) rows = rows.filter((task) => !task.lane)
    else if (laneFilter) rows = rows.filter((task) => task.lane === laneFilter)
    if (quadrantFilter) rows = rows.filter((task) => task.priority === quadrantFilter)
    return rows
  }, [tasks, laneFilter, quadrantFilter])

  const moveTask = async (id: string, next: BoardStatus) => {
    if (saving.current) return
    const task = tasks.find((item) => item.id === id)
    if (!task || task.status === next) return
    saving.current = true
    try {
      await apiClient.updateBoardTask(id, { status: next })
      setStatus({ text: tf('tw_task_moved', { title: task.title, status: t(`tw_status_${next}`) }) })
      await load()
      // The re-render moved the card to another lane, which takes the select
      // that had focus with it. Put focus back so keyboard users can carry on.
      window.requestAnimationFrame(() => {
        const select = lanesRef.current?.querySelector<HTMLSelectElement>(
          `[data-task-id="${CSS.escape(id)}"] select`
        )
        select?.focus()
      })
    } catch (err) {
      await load()
      setStatus({ text: tf('tw_task_save_failed', { msg: message(err) }), error: true })
    } finally {
      saving.current = false
    }
  }

  const removeTask = async (task: BoardTask) => {
    const ok = await askConfirm({
      titleKey: 'tw_task_delete_title',
      msgKey: 'tw_task_delete_confirm',
      vars: { title: task.title },
      okKey: 'tw_delete',
    })
    if (!ok) return
    try {
      await apiClient.deleteBoardTask(task.id)
      setStatus({ text: tf('tw_task_deleted', { title: task.title }) })
      await load()
    } catch (err) {
      setStatus({ text: tf('tw_task_save_failed', { msg: message(err) }), error: true })
    }
  }

  const openCreate = () => setDialog({ open: true, task: null })
  const closeDialog = () => setDialog({ open: false, task: null })

  const now = new Date()
  const todayStr = localDate(now)
  const tomorrowStr = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const todayNumber = dayNumber(todayStr)
  const counts = STATUSES.map((item) => visible.filter((task) => task.status === item).length)
  const laneCountText = STATUSES.map((item, i) => `${t(`tw_status_${item}`)} ${counts[i]}`).join('，')

  return (
    <div id="twb-board" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head">
            <div>
              <h1>{t('tw_board_title')}</h1>
              <p>{t('tw_board_desc')}</p>
            </div>
            <div className="twb-head-controls">
              <label className="twb-field twb-field-inline">
                <span>{t('tw_board_lane')}</span>
                <select
                  className="twb-select"
                  value={laneFilter}
                  onChange={(e) => setLaneFilter(e.target.value)}
                >
                  <option value="">{t('tw_board_lane_all')}</option>
                  {lanes.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                  {loose && <option value={LANE_NONE}>{t('tw_board_lane_none')}</option>}
                </select>
              </label>
              <label className="twb-field twb-field-inline">
                <span>{t('tw_board_sort')}</span>
                <select
                  className="twb-select"
                  value={sortMode}
                  onChange={(e) =>
                    setSortMode(
                      e.target.value === 'created'
                        ? 'created'
                        : e.target.value === 'priority'
                          ? 'priority'
                          : 'due'
                    )
                  }
                >
                  <option value="due">{t('tw_board_sort_due')}</option>
                  <option value="priority">{t('tw_board_sort_priority')}</option>
                  <option value="created">{t('tw_board_sort_created')}</option>
                </select>
              </label>
              <button type="button" className="twb-btn twb-btn-primary" onClick={openCreate}>
                <Plus size={15} />
                <span>{t('tw_board_new')}</span>
              </button>
            </div>
          </header>

          <div className="twb-quad-filter" role="group" aria-label={t('tw_board_filter_priority')}>
            <button
              type="button"
              className={`twb-chip twb-quad-filter-btn${quadrantFilter ? '' : ' is-on'}`}
              aria-pressed={!quadrantFilter}
              onClick={() => setQuadrantFilter('')}
            >
              {t('tw_board_filter_all')}
            </button>
            {QUADRANTS.map((item) => (
              <button
                key={item}
                type="button"
                className={`twb-chip twb-quad twb-quad-${item}${
                  quadrantFilter === item ? ' is-on' : ''
                }`}
                aria-pressed={quadrantFilter === item}
                onClick={() =>
                  setQuadrantFilter(quadrantFilter === item ? '' : item)
                }
              >
                {t(`tw_priority_${item}`)}
              </button>
            ))}
          </div>

          <p className={`twb-status${status.error ? ' is-error' : ''}`} role="status">
            {status.text}
          </p>
          {/* Counts, announced whenever the board reloads. */}
          <p className="twb-sr-only" role="status" aria-live="polite">
            {tf('tw_board_total', { n: board?.total ?? tasks.length })}，{laneCountText}
          </p>

          {loading && !tasks.length ? (
            <p className="twb-loading">{t('tw_loading')}</p>
          ) : (
            <div className="twb-board" ref={lanesRef}>
              {STATUSES.map((statusKey) => {
                const laneTasks = sortTasks(
                  visible.filter((task) => task.status === statusKey),
                  sortMode
                )
                return (
                  <section
                    key={statusKey}
                    className={`twb-lane${dropStatus === statusKey ? ' is-drop-target' : ''}`}
                    aria-labelledby={`twb-lane-${statusKey}`}
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                      setDropStatus(statusKey)
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropStatus(null)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDropStatus(null)
                      const id = e.dataTransfer?.getData('text/plain') || draggingId
                      setDraggingId('')
                      if (id) void moveTask(id, statusKey)
                    }}
                  >
                    <div className="twb-lane-head">
                      <h2 id={`twb-lane-${statusKey}`}>{t(`tw_status_${statusKey}`)}</h2>
                      <span className="twb-lane-count">{laneTasks.length}</span>
                    </div>
                    <div className="twb-lane-body">
                      {laneTasks.length ? (
                        laneTasks.map((task) => {
                          const daysLate =
                            task.due && task.status !== 'done'
                              ? todayNumber - dayNumber(task.due)
                              : 0
                          const overdue = daysLate > 0
                          const dueText =
                            task.status === 'done' && task.done_at
                              ? tf('tw_task_done_at', { time: formatMoment(task.done_at) })
                              : dueLabel(task, todayStr, tomorrowStr)
                          return (
                            <article
                              key={task.id}
                              data-task-id={task.id}
                              className={`twb-task${overdue ? ' is-overdue' : ''}${
                                draggingId === task.id ? ' is-dragging' : ''
                              }`}
                              draggable
                              onDragStart={(e) => {
                                setDraggingId(task.id)
                                if (e.dataTransfer) {
                                  e.dataTransfer.effectAllowed = 'move'
                                  e.dataTransfer.setData('text/plain', task.id)
                                }
                              }}
                              onDragEnd={() => {
                                setDraggingId('')
                                setDropStatus(null)
                              }}
                            >
                              <div className="twb-task-labels">
                                <span className={`twb-chip twb-quad twb-quad-${task.priority}`}>
                                  {t(`tw_priority_${task.priority}`)}
                                </span>
                                {task.category && (
                                  <span className="twb-chip twb-chip-category">{task.category}</span>
                                )}
                                {overdue && (
                                  <span className="twb-chip twb-chip-overdue">
                                    {tf('tw_task_overdue_days', { n: daysLate })}
                                  </span>
                                )}
                                {task.lane && (
                                  <span className="twb-chip twb-chip-lane">{task.lane}</span>
                                )}
                              </div>
                              <h3 className="twb-task-title">{task.title}</h3>
                              {task.note && <p className="twb-task-note">{task.note}</p>}
                              <div className="twb-task-meta">
                                <span className={`twb-task-due${overdue ? ' is-overdue' : ''}`}>
                                  {dueText}
                                </span>
                                {task.updated_at && (
                                  <time className="twb-task-stamp" dateTime={task.updated_at}>
                                    {tf('tw_task_updated_at', { time: formatMoment(task.updated_at) })}
                                  </time>
                                )}
                              </div>
                              <div className="twb-task-foot">
                                <select
                                  className="twb-select"
                                  aria-label={t('tw_task_move')}
                                  value={task.status}
                                  onChange={(e) => void moveTask(task.id, e.target.value as BoardStatus)}
                                >
                                  {STATUSES.map((item) => (
                                    <option key={item} value={item}>
                                      {t(`tw_status_${item}`)}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="twb-icon-btn"
                                  aria-label={t('tw_task_edit')}
                                  title={t('tw_task_edit')}
                                  onClick={() => setDialog({ open: true, task })}
                                >
                                  <Pencil size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="twb-icon-btn is-danger"
                                  aria-label={t('tw_task_delete')}
                                  title={t('tw_task_delete')}
                                  onClick={() => void removeTask(task)}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </article>
                          )
                        })
                      ) : (
                        <div className="twb-lane-empty">{t('tw_board_empty_col')}</div>
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
          )}

          <p className="twb-footnote">{tf('tw_board_total', { n: board?.total ?? tasks.length })}</p>
        </div>
      </div>

      {dialog.open && (
        <TaskDialog
          key={dialog.task?.id || 'new'}
          task={dialog.task}
          lanes={lanes}
          defaultLane={laneFilter && laneFilter !== LANE_NONE ? laneFilter : ''}
          onClose={closeDialog}
          onSaved={(text) => {
            closeDialog()
            setStatus({ text })
            void load()
          }}
        />
      )}
    </div>
  )
}

export default BoardPage
