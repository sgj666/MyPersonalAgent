import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { t, tf } from '../i18n'
import apiClient from '../api/client'
import { askConfirm } from '../store/confirmStore'
import type { BoardPriority, BoardSnapshot, BoardStatus, BoardTask } from '../types'

interface BoardPageProps {
  baseUrl: string
}

/** The four lanes are the board's shape, not a property of its contents. */
const STATUSES: BoardStatus[] = ['todo', 'doing', 'blocked', 'done']
const PRIORITIES: BoardPriority[] = ['low', 'normal', 'high']
/** Lane filter value for tasks that have no lane of their own. */
const LANE_NONE = '__none__'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Display order. `due` puts the nearest deadline first, tasks without one last,
 * and breaks ties by priority then creation; `created` is newest first. Mirrors
 * the web console so both clients show the same board.
 */
function sortTasks(rows: BoardTask[], mode: 'due' | 'created'): BoardTask[] {
  const sorted = rows.slice()
  if (mode === 'created') {
    sorted.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    return sorted
  }
  const weight: Record<string, number> = { high: 0, normal: 1, low: 2 }
  sorted.sort((a, b) => {
    if (a.due !== b.due) {
      if (!a.due) return 1
      if (!b.due) return -1
      return a.due.localeCompare(b.due)
    }
    const pa = weight[a.priority] == null ? 1 : weight[a.priority]
    const pb = weight[b.priority] == null ? 1 : weight[b.priority]
    if (pa !== pb) return pa - pb
    return String(a.created_at || '').localeCompare(String(b.created_at || ''))
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
  const [priority, setPriority] = useState<BoardPriority>(task?.priority || 'normal')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
          <div className="twb-field-row">
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
            <label className="twb-field">
              <span>{t('tw_task_due_label')}</span>
              <input className="twb-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          </div>
          <label className="twb-field">
            <span>{t('tw_task_priority')}</span>
            <select
              className="twb-select"
              value={priority}
              onChange={(e) => setPriority(e.target.value as BoardPriority)}
            >
              {PRIORITIES.map((item) => (
                <option key={item} value={item}>
                  {t(`tw_priority_${item}`)}
                </option>
              ))}
            </select>
          </label>
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
  const [sortMode, setSortMode] = useState<'due' | 'created'>('due')
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
    if (!laneFilter) return tasks
    if (laneFilter === LANE_NONE) return tasks.filter((task) => !task.lane)
    return tasks.filter((task) => task.lane === laneFilter)
  }, [tasks, laneFilter])

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

  // Local calendar date, not ISO: a task is late by the teacher's day.
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
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
                  onChange={(e) => setSortMode(e.target.value === 'created' ? 'created' : 'due')}
                >
                  <option value="due">{t('tw_board_sort_due')}</option>
                  <option value="created">{t('tw_board_sort_created')}</option>
                </select>
              </label>
              <button type="button" className="twb-btn twb-btn-primary" onClick={openCreate}>
                <Plus size={15} />
                <span>{t('tw_board_new')}</span>
              </button>
            </div>
          </header>

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
                          const overdue = !!task.due && task.status !== 'done' && task.due < todayStr
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
                              <div className="twb-task-top">
                                {task.priority !== 'normal' && (
                                  <span
                                    className={`twb-chip ${
                                      task.priority === 'high' ? 'twb-chip-prio-high' : 'twb-chip-prio-low'
                                    }`}
                                  >
                                    {t(`tw_priority_${task.priority}`)}
                                  </span>
                                )}
                                {task.due ? (
                                  <span className={`twb-chip ${overdue ? 'twb-chip-overdue' : 'twb-chip-due'}`}>
                                    {task.due}
                                    {overdue ? ` · ${t('tw_task_overdue')}` : ''}
                                  </span>
                                ) : (
                                  <span className="twb-chip twb-chip-due">{t('tw_task_none_due')}</span>
                                )}
                              </div>
                              <h3>{task.title}</h3>
                              {task.note && <p className="twb-task-note">{task.note}</p>}
                              {task.lane && (
                                <div className="twb-task-top" style={{ marginTop: 8 }}>
                                  <span className="twb-chip twb-chip-lane">{task.lane}</span>
                                </div>
                              )}
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
