import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCheck, ClipboardCopy, ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react'
import { t, tf } from '../i18n'
import apiClient from '../api/client'
import { askConfirm } from '../store/confirmStore'
import {
  HOMEWORK_KINDS,
  HOMEWORK_STATES,
  errorText,
  nextClassDate,
  todayISO,
} from '../lib/teaching'
import { Empty, Loading, Modal, PageError, Status, copyToClipboard } from './teachingShared'
import AiAssistButton from '../components/AiAssistButton'
import type {
  HomeworkFields,
  HomeworkItem,
  HomeworkKind,
  HomeworkState,
  TeachingClass,
  TeachingStudent,
  TimetableSlot,
} from '../types'

interface HomeworkPageProps {
  baseUrl: string
}


const HomeworkDialog: React.FC<{
  initial: HomeworkItem | null
  classes: TeachingClass[]
  slots: TimetableSlot[]
  onClose: () => void
  onSubmit: (fields: HomeworkFields) => Promise<void>
}> = ({ initial, classes, slots, onClose, onSubmit }) => {
  const [title, setTitle] = useState(initial?.title || '')
  const [kind, setKind] = useState<HomeworkKind>(initial?.kind || 'practice')
  const [classIds, setClassIds] = useState<string[]>(initial?.class_ids || [])
  const [due, setDue] = useState(initial?.due || '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // A deadline the teacher typed is theirs; only a blank one follows the class.
  const dueTouched = useRef(Boolean(initial?.due))

  const toggleClass = (id: string) => {
    const next = classIds.includes(id) ? classIds.filter((item) => item !== id) : [...classIds, id]
    setClassIds(next)
    if (!dueTouched.current && next.length) setDue(nextClassDate(slots, next[0]))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!title.trim()) {
      setError(t('tw_hw_title_required'))
      return
    }
    if (!classIds.length) {
      setError(t('tw_hw_pick_class'))
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit({
        title: title.trim(),
        kind,
        class_ids: classIds,
        due: due || nextClassDate(slots, classIds[0]),
      })
    } catch (err) {
      setError(tf('tw_save_failed', { msg: errorText(err) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      titleId="twb-hw-dialog-title"
      title={t(initial ? 'tw_hw_edit' : 'tw_hw_new')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="twb-btn" onClick={onClose}>
            {t('tw_cancel')}
          </button>
          <button type="submit" form="twb-hw-form" className="twb-btn twb-btn-primary" disabled={saving}>
            {t('tw_save')}
          </button>
        </>
      }
    >
      <form id="twb-hw-form" className="twb-form-body" onSubmit={submit}>
        <label className="twb-field">
          <span>{t('tw_hw_title')}</span>
          <input
            className="twb-input"
            type="text"
            required
            maxLength={80}
            autoFocus
            value={title}
            placeholder={t('tw_hw_title_ph')}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="twb-field-row">
          <label className="twb-field">
            <span>{t('tw_hw_kind')}</span>
            <select
              className="twb-select"
              value={kind}
              onChange={(e) => setKind(e.target.value as HomeworkKind)}
            >
              {HOMEWORK_KINDS.map((item) => (
                <option key={item} value={item}>
                  {t(`tw_hwk_${item}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="twb-field">
            <span>{t('tw_hw_due')}</span>
            <input
              className="twb-input"
              type="date"
              value={due}
              onChange={(e) => {
                dueTouched.current = true
                setDue(e.target.value)
              }}
            />
          </label>
        </div>
        <fieldset className="twb-field twb-fieldset">
          <legend>{t('tw_hw_classes')}</legend>
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
        <p className="twb-hint">{t('tw_hw_due_hint')}</p>
        {error && <p className="twb-status is-error">{error}</p>}
      </form>
    </Modal>
  )
}

/** The store's kind key, shown in the current language. */
const homeworkKindLabel = (kind: HomeworkKind): string => {
  const key = `tw_hwk_${kind}`
  const label = t(key)
  return label === key ? kind : label
}

const HomeworkPage: React.FC<HomeworkPageProps> = ({ baseUrl }) => {
  const [classes, setClasses] = useState<TeachingClass[]>([])
  const [slots, setSlots] = useState<TimetableSlot[]>([])
  const [items, setItems] = useState<HomeworkItem[]>([])
  const [records, setRecords] = useState<Record<string, Record<string, HomeworkState>>>({})
  const [selectedId, setSelectedId] = useState('')
  const [rosters, setRosters] = useState<Record<string, TeachingStudent[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [rosterLoading, setRosterLoading] = useState(false)
  const [dialog, setDialog] = useState<{ open: boolean; target: HomeworkItem | null }>({
    open: false,
    target: null,
  })
  const rostersRef = useRef(rosters)
  rostersRef.current = rosters
  // Records are one block per homework; a change while a PUT is in flight is
  // remembered and sent once it settles, so the last edit always wins.
  const pendingRecords = useRef<Record<string, HomeworkState> | null>(null)
  const pendingHomework = useRef('')
  const savingRecords = useRef(false)

  const load = useCallback(async () => {
    apiClient.setBaseUrl(baseUrl)
    setError('')
    try {
      const [classRows, timetable, homework] = await Promise.all([
        apiClient.listTeachingClasses(),
        apiClient.getTeachingTimetable(),
        apiClient.getTeachingHomework(),
      ])
      setClasses(classRows)
      setSlots(timetable.slots)
      setItems(homework.items)
      setRecords(homework.records)
      setSelectedId((prev) =>
        prev && homework.items.some((item) => item.id === prev) ? prev : homework.items[0]?.id || ''
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  const selected = items.find((item) => item.id === selectedId) || null

  useEffect(() => {
    if (!selected) return
    const missing = selected.class_ids.filter((id) => !rostersRef.current[id])
    if (!missing.length) return
    let cancelled = false
    setRosterLoading(true)
    Promise.all(
      missing.map(async (id) => [id, await apiClient.listTeachingStudents(id)] as const)
    )
      .then((entries) => {
        if (cancelled) return
        setRosters((prev) => {
          const next = { ...prev }
          entries.forEach(([id, rows]) => {
            next[id] = rows
          })
          return next
        })
      })
      .catch((err) => {
        if (!cancelled) setStatus(tf('tw_load_failed_msg', { msg: errorText(err) }))
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `rosters` is read through a ref: loading one homework's roster must not
    // re-run this effect for every student list it just stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.class_ids.join(',')])

  const flushRecords = useCallback(async () => {
    if (savingRecords.current) return
    const payload = pendingRecords.current
    const homeworkId = pendingHomework.current
    if (!payload || !homeworkId) return
    pendingRecords.current = null
    savingRecords.current = true
    try {
      await apiClient.saveTeachingHomeworkRecords(homeworkId, payload)
      setStatus(t('tw_hw_saved'))
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    } finally {
      savingRecords.current = false
      if (pendingRecords.current) void flushRecords()
    }
  }, [])

  const commitRecords = (homeworkId: string, next: Record<string, HomeworkState>) => {
    setRecords((prev) => ({ ...prev, [homeworkId]: next }))
    pendingRecords.current = next
    pendingHomework.current = homeworkId
    void flushRecords()
  }

  const setStudentState = (studentId: string, state: HomeworkState | '') => {
    if (!selected) return
    const current = records[selected.id] || {}
    const next = { ...current }
    if (state) next[studentId] = state
    else delete next[studentId]
    commitRecords(selected.id, next)
  }

  const studentsOf = (classId: string) => rosters[classId] || []

  const summary = useMemo(() => {
    if (!selected) return { total: 0, handed: 0, missing: [] as TeachingStudent[] }
    const rows = selected.class_ids.flatMap((id) => studentsOf(id))
    const book = records[selected.id] || {}
    const handed = rows.filter(
      (student) => book[student.id] === 'submitted' || book[student.id] === 'excellent'
    ).length
    const missing = rows.filter((student) => book[student.id] !== 'submitted' && book[student.id] !== 'excellent')
    return { total: rows.length, handed, missing }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, records, rosters])

  const markRestSubmitted = () => {
    if (!selected) return
    const book = { ...(records[selected.id] || {}) }
    selected.class_ids
      .flatMap((id) => studentsOf(id))
      .forEach((student) => {
        if (!book[student.id]) book[student.id] = 'submitted'
      })
    commitRecords(selected.id, book)
  }

  const copyMissing = async () => {
    if (!selected) return
    const book = records[selected.id] || {}
    const lines = selected.class_ids.map((classId) => {
      const names = studentsOf(classId)
        .filter((student) => !book[student.id] || book[student.id] === 'missing')
        .map((student) => student.name)
      return names.length
        ? `${classes.find((item) => item.id === classId)?.name || classId}：${names.join('、')}`
        : ''
    })
    const text = lines.filter(Boolean).join('\n')
    if (!text) {
      setStatus(t('tw_hw_no_missing'))
      return
    }
    const ok = await copyToClipboard(text)
    setStatus(ok ? t('tw_hw_copied') : t('tw_hw_copy_failed'))
  }

  const saveHomework = async (fields: HomeworkFields) => {
    try {
      if (dialog.target) await apiClient.updateTeachingHomework(dialog.target.id, fields)
      else await apiClient.createTeachingHomework(fields)
      setDialog({ open: false, target: null })
      setStatus(tf(dialog.target ? 'tw_hw_saved_item' : 'tw_hw_created', { title: fields.title || '' }))
      await load()
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  const deleteHomework = async (item: HomeworkItem) => {
    const ok = await askConfirm({
      titleKey: 'tw_hw_delete_title',
      msgKey: 'tw_hw_delete_confirm',
      vars: { title: item.title },
      okKey: 'tw_delete',
    })
    if (!ok) return
    try {
      await apiClient.deleteTeachingHomework(item.id)
      setStatus(tf('tw_hw_deleted', { title: item.title }))
      if (selectedId === item.id) setSelectedId('')
      await load()
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  const today = todayISO()

  return (
    <div id="twb-homework" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head">
            <div>
              <h1>{t('tw_hw_title_page')}</h1>
              <p>{t('tw_hw_desc')}</p>
            </div>
            <div className="twb-head-controls">
              <button
                type="button"
                className="twb-btn twb-btn-primary"
                disabled={!classes.length}
                onClick={() => setDialog({ open: true, target: null })}
              >
                <Plus size={15} />
                <span>{t('tw_hw_new')}</span>
              </button>
              <AiAssistButton
                dataTool="homework"
                scene={t('ai_scene_homework')}
                examples={[t('ai_ex_homework_1'), t('ai_ex_homework_2'), t('ai_ex_homework_3')]}
              />
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
                  <h2>{t('tw_hw_list')}</h2>
                  <span className="twb-count">{items.length}</span>
                </div>
                {items.length ? (
                  <ul className="twb-side-list">
                    {items.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={`twb-side-item${item.id === selectedId ? ' is-active' : ''}`}
                          onClick={() => setSelectedId(item.id)}
                        >
                          <b>{item.title}</b>
                          <small>
                            {homeworkKindLabel(item.kind)}
                            {item.due ? ` · ${item.due}` : ''}
                            {item.due && item.due < today ? ` · ${t('tw_hw_overdue')}` : ''}
                          </small>
                          <small>
                            {item.class_ids
                              .map((id) => classes.find((row) => row.id === id)?.name || '')
                              .filter(Boolean)
                              .join('、')}
                          </small>
                        </button>
                        <span className="twb-side-actions">
                          <button
                            type="button"
                            className="twb-icon-btn"
                            title={t('tw_hw_edit')}
                            aria-label={t('tw_hw_edit')}
                            onClick={() => setDialog({ open: true, target: item })}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            className="twb-icon-btn is-danger"
                            title={t('tw_delete')}
                            aria-label={t('tw_delete')}
                            onClick={() => void deleteHomework(item)}
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty
                    icon={ClipboardList}
                    text={t('tw_hw_empty')}
                    actionLabel={classes.length ? t('tw_hw_new') : undefined}
                    onAction={() => setDialog({ open: true, target: null })}
                  />
                )}
              </aside>

              <section className="twb-card twb-hw-main" aria-labelledby="twb-hw-main-title">
                {!selected ? (
                  <Empty icon={ClipboardList} text={t('tw_hw_pick')} />
                ) : (
                  <>
                    <div className="twb-card-head">
                      <div>
                        <h2 id="twb-hw-main-title">{selected.title}</h2>
                        <p className="twb-hint">
                          {homeworkKindLabel(selected.kind)}
                          {selected.due ? ` · ${tf('tw_hw_due_at', { date: selected.due })}` : ''}
                          {` · ${tf('tw_hw_rate', {
                            handed: summary.handed,
                            total: summary.total,
                            pct: Math.round(
                              (summary.total ? summary.handed / summary.total : 0) * 100
                            ),
                          })}`}
                        </p>
                      </div>
                      <div className="twb-head-controls">
                        <button
                          type="button"
                          className="twb-btn"
                          disabled={!summary.total}
                          onClick={markRestSubmitted}
                        >
                          <CheckCheck size={14} />
                          <span>{t('tw_hw_rest_submitted')}</span>
                        </button>
                        <button
                          type="button"
                          className="twb-btn"
                          disabled={!summary.total}
                          onClick={() => void copyMissing()}
                        >
                          <ClipboardCopy size={14} />
                          <span>{t('tw_hw_copy_missing')}</span>
                        </button>
                      </div>
                    </div>

                    {rosterLoading ? (
                      <Loading />
                    ) : (
                      selected.class_ids.map((classId) => {
                        const rows = studentsOf(classId)
                        const book = records[selected.id] || {}
                        return (
                          <div className="twb-hw-class" key={classId}>
                            <h3>
                              {classes.find((item) => item.id === classId)?.name || classId}
                              <span className="twb-count">{rows.length}</span>
                            </h3>
                            {rows.length ? (
                              <div className="twb-hw-grid">
                                {rows.map((student) => (
                                  <label
                                    key={student.id}
                                    className={`twb-hw-cell is-${book[student.id] || 'none'}`}
                                  >
                                    <span className="twb-hw-name">
                                      <b>{student.name}</b>
                                      <small>{student.no}</small>
                                    </span>
                                    <select
                                      className="twb-select twb-hw-select"
                                      value={book[student.id] || ''}
                                      onChange={(e) =>
                                        setStudentState(
                                          student.id,
                                          e.target.value as HomeworkState | ''
                                        )
                                      }
                                    >
                                      <option value="">{t('tw_hw_state_none')}</option>
                                      {HOMEWORK_STATES.map((state) => (
                                        <option key={state} value={state}>
                                          {t(`tw_hw_state_${state}`)}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                ))}
                              </div>
                            ) : (
                              <p className="twb-hint">{t('tw_hw_no_students')}</p>
                            )}
                          </div>
                        )
                      })
                    )}
                  </>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {dialog.open && (
        <HomeworkDialog
          initial={dialog.target}
          classes={classes}
          slots={slots}
          onClose={() => setDialog({ open: false, target: null })}
          onSubmit={saveHomework}
        />
      )}
    </div>
  )
}

export default HomeworkPage
