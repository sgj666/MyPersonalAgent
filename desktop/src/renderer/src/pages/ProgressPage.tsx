import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpenCheck, ClipboardPaste, Plus, Trash2 } from 'lucide-react'
import { t, tf } from '../i18n'
import apiClient from '../api/client'
import { askConfirm } from '../store/confirmStore'
import {
  computePace,
  defaultTerm,
  errorText,
  parsePlanPaste,
  termFraction,
} from '../lib/teaching'
import { EditableCell, Empty, Loading, Modal, PageError, Status } from './teachingShared'
import type { ProgressFields, ProgressItem, TeachingClass } from '../types'

interface ProgressPageProps {
  baseUrl: string
}

interface Term {
  start: string
  end: string
}

const TERM_KEY = 'twb_term:'

function readTerm(classId: string): Term {
  const fallback = defaultTerm()
  if (!classId) return fallback
  try {
    const saved = JSON.parse(localStorage.getItem(TERM_KEY + classId) || 'null')
    if (saved && typeof saved.start === 'string' && typeof saved.end === 'string') {
      return { start: saved.start, end: saved.end }
    }
  } catch {
    // A corrupt value falls back to this semester's dates.
  }
  return fallback
}

const ProgressPage: React.FC<ProgressPageProps> = ({ baseUrl }) => {
  const [classes, setClasses] = useState<TeachingClass[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [items, setItems] = useState<ProgressItem[]>([])
  const [loading, setLoading] = useState(true)
  const [itemsLoading, setItemsLoading] = useState(false)
  const [error, setError] = useState('')
  const [itemsError, setItemsError] = useState('')
  const [status, setStatus] = useState('')
  const [term, setTerm] = useState<Term>(() => readTerm(''))
  const [draft, setDraft] = useState({ topic: '', planned: '' })
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [importing, setImporting] = useState(false)
  const classToken = useRef(0)
  const itemToken = useRef(0)

  const loadClasses = useCallback(async () => {
    const token = ++classToken.current
    apiClient.setBaseUrl(baseUrl)
    setError('')
    try {
      const rows = await apiClient.listTeachingClasses()
      if (token !== classToken.current) return
      setClasses(rows)
      setSelectedId((prev) => (prev && rows.some((row) => row.id === prev) ? prev : rows[0]?.id || ''))
    } catch (err) {
      if (token === classToken.current) setError(errorText(err))
    } finally {
      if (token === classToken.current) setLoading(false)
    }
  }, [baseUrl])

  const loadItems = useCallback(async (classId: string) => {
    const token = ++itemToken.current
    setItemsLoading(true)
    setItemsError('')
    try {
      const rows = await apiClient.listTeachingProgress(classId)
      if (token !== itemToken.current) return
      setItems(rows)
    } catch (err) {
      if (token === itemToken.current) setItemsError(errorText(err))
    } finally {
      if (token === itemToken.current) setItemsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadClasses()
  }, [loadClasses])

  useEffect(() => {
    if (!selectedId) {
      setItems([])
      return
    }
    setTerm(readTerm(selectedId))
    void loadItems(selectedId)
  }, [selectedId, loadItems])

  const selected = classes.find((item) => item.id === selectedId) || null
  const ordered = useMemo(
    () => items.slice().sort((a, b) => (a.order - b.order) || a.topic.localeCompare(b.topic, 'zh')),
    [items]
  )
  const pace = useMemo(
    () => computePace(items, termFraction(term.start, term.end)),
    [items, term]
  )
  const plan = useMemo(() => parsePlanPaste(pasteText), [pasteText])

  const saveTerm = (next: Term) => {
    setTerm(next)
    try {
      localStorage.setItem(TERM_KEY + selectedId, JSON.stringify(next))
    } catch {
      // Storage may be unavailable; the inputs still drive the pace this session.
    }
  }

  const nextOrder = () => items.reduce((max, item) => Math.max(max, item.order || 0), 0) + 1

  const createItem = async (fields: ProgressFields, message: string) => {
    if (!selected) return
    try {
      await apiClient.createTeachingProgress({ class_id: selected.id, ...fields })
      setStatus(message)
      await loadItems(selected.id)
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  const addDraft = async (e: React.FormEvent) => {
    e.preventDefault()
    const topic = draft.topic.trim()
    if (!topic) return
    const planned = Math.max(1, Number(draft.planned) || 1)
    setDraft({ topic: '', planned: '' })
    await createItem({ topic, planned_periods: planned, taught_periods: 0, order: nextOrder() }, t('tw_prog_added'))
  }

  const patchItem = async (item: ProgressItem, fields: ProgressFields, message: string) => {
    setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, ...fields } : row)))
    try {
      await apiClient.updateTeachingProgress(item.id, fields)
      setStatus(message)
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
      setItems((prev) => prev.map((row) => (row.id === item.id ? item : row)))
    }
  }

  const deleteItem = async (item: ProgressItem) => {
    const ok = await askConfirm({
      titleKey: 'tw_prog_delete_title',
      msgKey: 'tw_prog_delete_confirm',
      vars: { topic: item.topic },
      okKey: 'tw_delete',
    })
    if (!ok) return
    try {
      await apiClient.deleteTeachingProgress(item.id)
      setItems((prev) => prev.filter((row) => row.id !== item.id))
      setStatus(t('tw_prog_deleted'))
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  const importPlan = async () => {
    if (!selected || !plan.length) return
    setImporting(true)
    let base = nextOrder()
    let done = 0
    try {
      for (const row of plan) {
        await apiClient.createTeachingProgress({
          class_id: selected.id,
          topic: row.topic,
          planned_periods: row.planned,
          taught_periods: 0,
          order: base++,
        })
        done++
      }
      setPasteOpen(false)
      setPasteText('')
      setStatus(tf('tw_prog_imported', { n: done }))
      await loadItems(selected.id)
    } catch (err) {
      setStatus(tf('tw_prog_import_failed', { n: done, msg: errorText(err) }))
      await loadItems(selected.id)
    } finally {
      setImporting(false)
    }
  }

  const remaining = Math.max(0, pace.planned - pace.taught)

  return (
    <div id="twb-progress" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head">
            <div>
              <h1>{t('tw_prog_title')}</h1>
              <p>{t('tw_prog_desc')}</p>
            </div>
            <div className="twb-head-controls">
              <label className="twb-field twb-field-inline">
                <span>{t('tw_classes_list')}</span>
                <select
                  className="twb-select"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  disabled={!classes.length}
                >
                  {classes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="twb-btn twb-btn-primary"
                disabled={!selected}
                onClick={() => setPasteOpen(true)}
              >
                <ClipboardPaste size={15} />
                <span>{t('tw_prog_paste')}</span>
              </button>
            </div>
          </header>

          <Status text={status} />

          {loading ? (
            <Loading />
          ) : error ? (
            <PageError message={error} onRetry={() => void loadClasses()} />
          ) : !selected ? (
            <Empty icon={BookOpenCheck} text={t('tw_prog_need_class')} />
          ) : (
            <>
              <section className="twb-card twb-term" aria-labelledby="twb-term-title">
                <div className="twb-card-head">
                  <h2 id="twb-term-title">{t('tw_term_title')}</h2>
                  <span className="twb-count">{selected.name}</span>
                </div>
                <div className="twb-term-row">
                  <label className="twb-field">
                    <span>{t('tw_term_start')}</span>
                    <input
                      className="twb-input"
                      type="date"
                      value={term.start}
                      onChange={(e) => saveTerm({ ...term, start: e.target.value })}
                    />
                  </label>
                  <label className="twb-field">
                    <span>{t('tw_term_end')}</span>
                    <input
                      className="twb-input"
                      type="date"
                      value={term.end}
                      onChange={(e) => saveTerm({ ...term, end: e.target.value })}
                    />
                  </label>
                  <p className="twb-hint">{tf('tw_term_hint', { pct: Math.round(termFraction(term.start, term.end) * 100) })}</p>
                </div>
              </section>

              <div className="twb-stats">
                <div className="twb-stat">
                  <span>{t('tw_prog_planned')}</span>
                  <b>{pace.planned}</b>
                </div>
                <div className="twb-stat">
                  <span>{t('tw_prog_taught')}</span>
                  <b>{pace.taught}</b>
                </div>
                <div className="twb-stat">
                  <span>{t('tw_prog_remaining')}</span>
                  <b>{remaining}</b>
                </div>
                <div className={`twb-stat twb-pace is-${pace.status}`}>
                  <span>{t('tw_prog_pace')}</span>
                  <b>{t(`tw_pace_${pace.status}`)}</b>
                  <small>{tf('tw_pace_expect', { n: pace.expected })}</small>
                </div>
              </div>

              <section className="twb-card" aria-labelledby="twb-prog-list-title">
                <div className="twb-card-head">
                  <h2 id="twb-prog-list-title">{t('tw_prog_list')}</h2>
                  <span className="twb-count">{items.length}</span>
                </div>

                <form className="twb-inline-form" onSubmit={addDraft}>
                  <input
                    className="twb-input"
                    type="text"
                    value={draft.topic}
                    placeholder={t('tw_prog_topic_ph')}
                    onChange={(e) => setDraft((prev) => ({ ...prev, topic: e.target.value }))}
                  />
                  <input
                    className="twb-input twb-narrow"
                    type="number"
                    min={1}
                    max={60}
                    value={draft.planned}
                    placeholder={t('tw_prog_planned_ph')}
                    onChange={(e) => setDraft((prev) => ({ ...prev, planned: e.target.value }))}
                  />
                  <button type="submit" className="twb-btn twb-btn-primary" disabled={!draft.topic.trim()}>
                    <Plus size={14} />
                    <span>{t('tw_prog_add')}</span>
                  </button>
                </form>

                {itemsLoading ? (
                  <Loading />
                ) : itemsError ? (
                  <PageError message={itemsError} onRetry={() => void loadItems(selected.id)} />
                ) : ordered.length ? (
                  <div className="twb-table-wrap">
                    <table className="twb-table twb-prog-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>{t('tw_prog_topic')}</th>
                          <th className="is-num">{t('tw_prog_planned')}</th>
                          <th className="is-num">{t('tw_prog_taught')}</th>
                          <th>{t('tw_prog_bar')}</th>
                          <th aria-label={t('tw_delete')} />
                        </tr>
                      </thead>
                      <tbody>
                        {ordered.map((item, index) => {
                          const ratio = item.planned_periods
                            ? Math.min(1, item.taught_periods / item.planned_periods)
                            : 0
                          const done = item.planned_periods > 0 && item.taught_periods >= item.planned_periods
                          return (
                            <tr key={item.id}>
                              <td className="is-num">{index + 1}</td>
                              <td>
                                <EditableCell
                                  value={item.topic}
                                  onCommit={(topic) => {
                                    if (!topic) return false
                                    void patchItem(item, { topic }, t('tw_prog_saved'))
                                  }}
                                />
                              </td>
                              <td className="is-num">
                                <EditableCell
                                  type="number"
                                  value={String(item.planned_periods)}
                                  onCommit={(raw) => {
                                    const planned = Math.max(1, Number(raw) || 0)
                                    if (!planned) return false
                                    void patchItem(item, { planned_periods: planned }, t('tw_prog_saved'))
                                  }}
                                />
                              </td>
                              <td className="is-num">
                                <EditableCell
                                  type="number"
                                  value={String(item.taught_periods)}
                                  onCommit={(raw) => {
                                    const taught = Math.max(0, Number(raw) || 0)
                                    void patchItem(item, { taught_periods: taught }, t('tw_prog_saved'))
                                  }}
                                />
                              </td>
                              <td>
                                <div className="twb-progress-bar" aria-hidden="true">
                                  <i style={{ width: `${Math.round(ratio * 100)}%` }} />
                                </div>
                                <small className="twb-hint">
                                  {tf('tw_prog_ratio', { done: item.taught_periods, all: item.planned_periods })}
                                </small>
                              </td>
                              <td className="is-actions">
                                <button
                                  type="button"
                                  className="twb-btn twb-btn-sm"
                                  disabled={done}
                                  onClick={() =>
                                    void patchItem(
                                      item,
                                      { taught_periods: item.taught_periods + 1 },
                                      tf('tw_prog_advanced', { topic: item.topic })
                                    )
                                  }
                                >
                                  {t('tw_prog_done_one')}
                                </button>
                                <button
                                  type="button"
                                  className="twb-icon-btn is-danger"
                                  title={t('tw_delete')}
                                  aria-label={t('tw_delete')}
                                  onClick={() => void deleteItem(item)}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={BookOpenCheck}
                    text={t('tw_prog_empty')}
                    actionLabel={t('tw_prog_paste')}
                    onAction={() => setPasteOpen(true)}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {pasteOpen && (
        <Modal
          titleId="twb-plan-paste-title"
          title={t('tw_prog_paste_title')}
          wide
          onClose={() => setPasteOpen(false)}
          footer={
            <>
              <button type="button" className="twb-btn" onClick={() => setPasteOpen(false)}>
                {t('tw_cancel')}
              </button>
              <button
                type="button"
                className="twb-btn twb-btn-primary"
                disabled={!plan.length || importing}
                onClick={() => void importPlan()}
              >
                {t('tw_prog_paste_action')}
              </button>
            </>
          }
        >
          <div className="twb-form-body">
            <p className="twb-hint">{t('tw_prog_paste_hint')}</p>
            <textarea
              className="twb-textarea twb-mono"
              rows={9}
              autoFocus
              value={pasteText}
              placeholder={t('tw_prog_paste_ph')}
              onChange={(e) => setPasteText(e.target.value)}
            />
            {pasteText.trim() && (
              <div className="twb-paste-preview">
                <p className="twb-hint">{tf('tw_prog_paste_count', { n: plan.length })}</p>
                {plan.length > 0 && (
                  <table className="twb-table">
                    <thead>
                      <tr>
                        <th>{t('tw_prog_topic')}</th>
                        <th className="is-num">{t('tw_prog_planned')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.slice(0, 10).map((row, index) => (
                        <tr key={`${row.topic}-${index}`}>
                          <td>{row.topic}</td>
                          <td className="is-num">{row.planned}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {plan.length > 10 && <p className="twb-footnote">{tf('tw_prog_paste_more', { n: plan.length - 10 })}</p>}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

export default ProgressPage
