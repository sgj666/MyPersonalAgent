import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardPaste, Pencil, Plus, Search, Trash2, Users } from 'lucide-react'
import { t, tf } from '../i18n'
import apiClient from '../api/client'
import { askConfirm } from '../store/confirmStore'
import { errorText, parseRosterPaste } from '../lib/teaching'
import { EditableCell, Empty, Loading, Modal, PageError, Status } from './teachingShared'
import type { TeachingClass, TeachingClassFields, TeachingStudent } from '../types'

interface ClassesPageProps {
  baseUrl: string
}

type SortKey = 'no' | 'name' | 'gender'

/** Class create/rename. Keyed by the class it edits, so its fields start there. */
const ClassDialog: React.FC<{
  initial: TeachingClass | null
  onClose: () => void
  onSubmit: (fields: TeachingClassFields) => Promise<void>
}> = ({ initial, onClose, onSubmit }) => {
  const [fields, setFields] = useState<TeachingClassFields>({
    name: initial?.name || '',
    grade: initial?.grade || '',
    subject: initial?.subject || '',
    room: initial?.room || '',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (key: keyof TeachingClassFields, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!fields.name.trim()) {
      setError(t('tw_classes_name_required'))
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit({
        name: fields.name.trim(),
        grade: (fields.grade || '').trim(),
        subject: (fields.subject || '').trim(),
        room: (fields.room || '').trim(),
      })
    } catch (err) {
      setError(tf('tw_save_failed', { msg: errorText(err) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      titleId="twb-class-dialog-title"
      title={t(initial ? 'tw_classes_edit' : 'tw_classes_new')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="twb-btn" onClick={onClose}>
            {t('tw_cancel')}
          </button>
          <button type="submit" form="twb-class-form" className="twb-btn twb-btn-primary" disabled={saving}>
            {t('tw_save')}
          </button>
        </>
      }
    >
      <form id="twb-class-form" className="twb-form-body" onSubmit={submit}>
        <label className="twb-field">
          <span>{t('tw_classes_name')}</span>
          <input
            className="twb-input"
            type="text"
            required
            maxLength={40}
            autoFocus
            value={fields.name}
            placeholder={t('tw_classes_name_ph')}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <div className="twb-field-row">
          <label className="twb-field">
            <span>{t('tw_classes_grade')}</span>
            <input
              className="twb-input"
              type="text"
              maxLength={20}
              value={fields.grade}
              placeholder={t('tw_classes_grade_ph')}
              onChange={(e) => set('grade', e.target.value)}
            />
          </label>
          <label className="twb-field">
            <span>{t('tw_classes_subject')}</span>
            <input
              className="twb-input"
              type="text"
              maxLength={20}
              value={fields.subject}
              placeholder={t('tw_classes_subject_ph')}
              onChange={(e) => set('subject', e.target.value)}
            />
          </label>
        </div>
        <label className="twb-field">
          <span>{t('tw_classes_room')}</span>
          <input
            className="twb-input"
            type="text"
            maxLength={30}
            value={fields.room}
            placeholder={t('tw_classes_room_ph')}
            onChange={(e) => set('room', e.target.value)}
          />
        </label>
        {error && <p className="twb-status is-error">{error}</p>}
      </form>
    </Modal>
  )
}

const ClassesPage: React.FC<ClassesPageProps> = ({ baseUrl }) => {
  const [classes, setClasses] = useState<TeachingClass[]>([])
  const [students, setStudents] = useState<TeachingStudent[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [error, setError] = useState('')
  const [studentsError, setStudentsError] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'no', dir: 1 })
  const [classDialog, setClassDialog] = useState<{ open: boolean; target: TeachingClass | null }>({
    open: false,
    target: null,
  })
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const classToken = useRef(0)
  const studentToken = useRef(0)

  const loadClasses = useCallback(async () => {
    const token = ++classToken.current
    apiClient.setBaseUrl(baseUrl)
    setError('')
    try {
      const rows = await apiClient.listTeachingClasses()
      if (token !== classToken.current) return
      setClasses(rows)
      setSelectedId((prev) =>
        prev && rows.some((item) => item.id === prev) ? prev : rows[0]?.id || ''
      )
    } catch (err) {
      if (token === classToken.current) setError(errorText(err))
    } finally {
      if (token === classToken.current) setLoading(false)
    }
  }, [baseUrl])

  const loadStudents = useCallback(
    async (classId: string) => {
      const token = ++studentToken.current
      setStudentsError('')
      setStudentsLoading(true)
      try {
        const rows = await apiClient.listTeachingStudents(classId)
        if (token !== studentToken.current) return
        setStudents(rows)
      } catch (err) {
        if (token === studentToken.current) setStudentsError(errorText(err))
      } finally {
        if (token === studentToken.current) setStudentsLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    void loadClasses()
  }, [loadClasses])

  useEffect(() => {
    if (!selectedId) {
      setStudents([])
      return
    }
    void loadStudents(selectedId)
  }, [selectedId, loadStudents])

  const selected = classes.find((item) => item.id === selectedId) || null
  const paste = useMemo(() => parseRosterPaste(pasteText), [pasteText])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const rows = needle
      ? students.filter((student) =>
          [student.no, student.name, student.gender, student.note, student.tags.join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(needle)
        )
      : students.slice()
    const dir = sort.dir
    rows.sort((a, b) => {
      if (sort.key === 'no') {
        const na = Number(a.no)
        const nb = Number(b.no)
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return (na - nb) * dir
        return a.no.localeCompare(b.no, 'zh') * dir
      }
      return a[sort.key].localeCompare(b[sort.key], 'zh') * dir
    })
    return rows
  }, [students, search, sort])

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))

  const saveClass = async (fields: TeachingClassFields) => {
    if (classDialog.target) await apiClient.updateTeachingClass(classDialog.target.id, fields)
    else await apiClient.createTeachingClass(fields)
    setClassDialog({ open: false, target: null })
    setStatus(tf(classDialog.target ? 'tw_classes_saved' : 'tw_classes_created', { name: fields.name }))
    await loadClasses()
  }

  const deleteClass = async (target: TeachingClass) => {
    const ok = await askConfirm({
      titleKey: 'tw_classes_delete_title',
      msgKey: 'tw_classes_delete_confirm',
      vars: { name: target.name },
      okKey: 'tw_delete',
    })
    if (!ok) return
    try {
      await apiClient.deleteTeachingClass(target.id)
      setStatus(tf('tw_classes_deleted', { name: target.name }))
      if (selectedId === target.id) setSelectedId('')
      await loadClasses()
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  const patchStudent = async (student: TeachingStudent, patch: Partial<TeachingStudent>) => {
    setStudents((prev) => prev.map((row) => (row.id === student.id ? { ...row, ...patch } : row)))
    try {
      await apiClient.updateTeachingStudent(student.id, patch)
      setStatus(tf('tw_st_saved', { name: patch.name || student.name }))
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
      // The server refused: put the old row back rather than showing a value
      // that was never stored.
      setStudents((prev) => prev.map((row) => (row.id === student.id ? student : row)))
    }
  }

  const deleteStudent = async (student: TeachingStudent) => {
    const ok = await askConfirm({
      titleKey: 'tw_st_delete_title',
      msgKey: 'tw_st_delete_confirm',
      vars: { name: student.name },
      okKey: 'tw_delete',
    })
    if (!ok) return
    try {
      await apiClient.deleteTeachingStudent(student.id)
      setStudents((prev) => prev.filter((row) => row.id !== student.id))
      setStatus(tf('tw_st_deleted', { name: student.name }))
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  const importStudents = async () => {
    if (!selected || !paste.rows.length) return
    try {
      await apiClient.importTeachingStudents(selected.id, paste.rows)
      setPasteOpen(false)
      setPasteText('')
      setStatus(tf('tw_classes_imported', { n: paste.rows.length, name: selected.name }))
      await loadStudents(selected.id)
    } catch (err) {
      setStatus(tf('tw_save_failed', { msg: errorText(err) }))
    }
  }

  return (
    <div id="twb-classes" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head">
            <div>
              <h1>{t('tw_classes_title')}</h1>
              <p>{t('tw_classes_desc')}</p>
            </div>
            <div className="twb-head-controls">
              <button
                type="button"
                className="twb-btn"
                onClick={() => setClassDialog({ open: true, target: null })}
              >
                <Plus size={15} />
                <span>{t('tw_classes_new')}</span>
              </button>
              <button
                type="button"
                className="twb-btn twb-btn-primary"
                disabled={!selected}
                onClick={() => setPasteOpen(true)}
              >
                <ClipboardPaste size={15} />
                <span>{t('tw_classes_import')}</span>
              </button>
            </div>
          </header>

          <Status text={status} />

          <div className="twb-split">
            <aside className="twb-card twb-side">
              <div className="twb-card-head">
                <h2>{t('tw_classes_list')}</h2>
                <span className="twb-count">{classes.length}</span>
              </div>
              {loading ? (
                <Loading />
              ) : error ? (
                <PageError message={error} onRetry={() => void loadClasses()} />
              ) : classes.length ? (
                <ul className="twb-side-list">
                  {classes.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`twb-side-item${item.id === selectedId ? ' is-active' : ''}`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <b>{item.name}</b>
                        <small>
                          {[item.grade, item.subject, item.room].filter(Boolean).join(' · ') ||
                            t('tw_classes_no_meta')}
                        </small>
                      </button>
                      <span className="twb-side-actions">
                        <button
                          type="button"
                          className="twb-icon-btn"
                          title={t('tw_classes_edit')}
                          aria-label={t('tw_classes_edit')}
                          onClick={() => setClassDialog({ open: true, target: item })}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className="twb-icon-btn is-danger"
                          title={t('tw_delete')}
                          aria-label={t('tw_delete')}
                          onClick={() => void deleteClass(item)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty
                  icon={Users}
                  text={t('tw_classes_empty')}
                  actionLabel={t('tw_classes_new')}
                  onAction={() => setClassDialog({ open: true, target: null })}
                />
              )}
            </aside>

            <section className="twb-card twb-roster" aria-labelledby="twb-roster-title">
              <div className="twb-card-head">
                <h2 id="twb-roster-title">
                  {selected ? selected.name : t('tw_classes_roster')}
                  {selected && <span className="twb-count">{students.length}</span>}
                </h2>
                {selected && (
                  <label className="twb-search">
                    <Search size={13} />
                    <input
                      type="search"
                      value={search}
                      placeholder={t('tw_classes_search_ph')}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                )}
              </div>

              {!selected ? (
                <Empty icon={Users} text={t('tw_classes_pick')} />
              ) : studentsLoading ? (
                <Loading />
              ) : studentsError ? (
                <PageError message={studentsError} onRetry={() => void loadStudents(selected.id)} />
              ) : students.length ? (
                <div className="twb-table-wrap">
                  <table className="twb-table twb-roster-table">
                    <thead>
                      <tr>
                        <th>
                          <button type="button" className="twb-sort" onClick={() => toggleSort('no')}>
                            {t('tw_st_no')}
                            {sort.key === 'no' && <span>{sort.dir === 1 ? '↑' : '↓'}</span>}
                          </button>
                        </th>
                        <th>
                          <button type="button" className="twb-sort" onClick={() => toggleSort('name')}>
                            {t('tw_st_name')}
                            {sort.key === 'name' && <span>{sort.dir === 1 ? '↑' : '↓'}</span>}
                          </button>
                        </th>
                        <th>{t('tw_st_gender')}</th>
                        <th>{t('tw_st_tags')}</th>
                        <th>{t('tw_st_note')}</th>
                        <th aria-label={t('tw_delete')} />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((student) => (
                        <tr key={student.id}>
                          <td className="is-num">
                            <EditableCell
                              value={student.no}
                              onCommit={(no) => {
                                if (!no) {
                                  setStatus(t('tw_st_no_required'))
                                  return false
                                }
                                void patchStudent(student, { no })
                              }}
                            />
                          </td>
                          <td>
                            <EditableCell
                              value={student.name}
                              onCommit={(name) => {
                                if (!name) return false
                                void patchStudent(student, { name })
                              }}
                            />
                          </td>
                          <td>
                            <EditableCell
                              value={student.gender}
                              onCommit={(gender) => void patchStudent(student, { gender })}
                            />
                          </td>
                          <td>
                            <EditableCell
                              value={student.tags.join(' ')}
                              onCommit={(tags) =>
                                void patchStudent(student, {
                                  tags: tags
                                    .split(/[,，、;；/\s]+/)
                                    .map((tag) => tag.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          </td>
                          <td>
                            <EditableCell
                              value={student.note}
                              onCommit={(note) => void patchStudent(student, { note })}
                            />
                          </td>
                          <td className="is-actions">
                            <button
                              type="button"
                              className="twb-icon-btn is-danger"
                              title={t('tw_delete')}
                              aria-label={t('tw_delete')}
                              onClick={() => void deleteStudent(student)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visible.length && <p className="twb-hint">{t('tw_classes_no_match')}</p>}
                </div>
              ) : (
                <Empty
                  icon={Users}
                  text={t('tw_classes_empty_roster')}
                  actionLabel={t('tw_classes_import')}
                  onAction={() => setPasteOpen(true)}
                />
              )}
            </section>
          </div>
        </div>
      </div>

      {classDialog.open && (
        <ClassDialog
          initial={classDialog.target}
          onClose={() => setClassDialog({ open: false, target: null })}
          onSubmit={saveClass}
        />
      )}

      {pasteOpen && (
        <Modal
          titleId="twb-paste-title"
          title={t('tw_classes_import_title')}
          wide
          onClose={() => setPasteOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="twb-btn"
                onClick={() => {
                  setPasteOpen(false)
                  setPasteText('')
                }}
              >
                {t('tw_cancel')}
              </button>
              <button
                type="button"
                className="twb-btn twb-btn-primary"
                disabled={!paste.rows.length}
                onClick={() => void importStudents()}
              >
                {t('tw_classes_import_action')}
              </button>
            </>
          }
        >
          <div className="twb-form-body">
            <p className="twb-hint">{t('tw_classes_import_hint')}</p>
            <textarea
              className="twb-textarea twb-mono"
              rows={8}
              autoFocus
              value={pasteText}
              placeholder={t('tw_classes_import_ph')}
              onChange={(e) => setPasteText(e.target.value)}
            />
            {pasteText.trim() && (
              <div className="twb-paste-preview">
                <p className="twb-hint">
                  {tf('tw_classes_import_count', { n: paste.rows.length })}
                  {paste.hasHeader ? ` · ${t('tw_classes_import_header')}` : ''}
                  {paste.skipped ? ` · ${tf('tw_classes_import_skipped', { n: paste.skipped })}` : ''}
                  {paste.duplicates
                    ? ` · ${tf('tw_classes_import_dupes', { n: paste.duplicates })}`
                    : ''}
                </p>
                {paste.rows.length > 0 && (
                  <div className="twb-table-wrap">
                    <table className="twb-table">
                      <thead>
                        <tr>
                          <th>{t('tw_st_no')}</th>
                          <th>{t('tw_st_name')}</th>
                          <th>{t('tw_st_gender')}</th>
                          <th>{t('tw_st_tags')}</th>
                          <th>{t('tw_st_note')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paste.rows.slice(0, 8).map((row) => (
                          <tr key={row.no}>
                            <td>{row.no}</td>
                            <td>{row.name}</td>
                            <td>{row.gender}</td>
                            <td>{row.tags.join(' ')}</td>
                            <td>{row.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {paste.rows.length > 8 && (
                      <p className="twb-footnote">{tf('tw_classes_import_more', { n: paste.rows.length - 8 })}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

export default ClassesPage
