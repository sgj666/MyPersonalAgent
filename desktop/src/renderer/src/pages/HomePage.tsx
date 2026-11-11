import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  BookOpen,
  Box,
  CalendarDays,
  ClipboardList,
  Copy,
  FileText,
  Lightbulb,
  Loader2,
  PenLine,
  Presentation,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { t, tf, getLang } from '../i18n'
import apiClient from '../api/client'
import OnboardingDialog from '../components/OnboardingDialog'
import { iconFor } from '../lib/fileKind'
import { todayISO } from '../lib/teaching'
import { dateTime } from './artifacts/format'
import type {
  BoardSnapshot,
  KnowledgeDir,
  KnowledgeList,
  ReminderPreview,
  TeachingGreeting,
  TeachingSettings,
  TeachingToday,
  TeacherProfile,
  TeacherProfileFields,
} from '../types'

interface HomePageProps {
  baseUrl: string
}

interface ToolCard {
  id: 'plan' | 'courseware' | 'card' | 'advice' | 'schedule'
  labelKey: string
  descKey: string
  icon: LucideIcon
  tone: string
}

// The five teaching tools, in the order the web console lists them.
const TOOLS: ToolCard[] = [
  { id: 'plan', labelKey: 'tw_tool_plan', descKey: 'tw_tool_plan_desc', icon: FileText, tone: 'twb-tool-a' },
  { id: 'courseware', labelKey: 'tw_tool_courseware', descKey: 'tw_tool_courseware_desc', icon: Presentation, tone: 'twb-tool-b' },
  { id: 'card', labelKey: 'tw_tool_card', descKey: 'tw_tool_card_desc', icon: Copy, tone: 'twb-tool-c' },
  { id: 'advice', labelKey: 'tw_tool_advice', descKey: 'tw_tool_advice_desc', icon: Lightbulb, tone: 'twb-tool-d' },
  { id: 'schedule', labelKey: 'tw_tool_schedule', descKey: 'tw_tool_schedule_desc', icon: CalendarDays, tone: 'twb-tool-e' },
]

const dateLine = (): string => {
  const locale = getLang() === 'zh' ? 'zh-CN' : 'en-US'
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(new Date())
  } catch {
    return new Date().toLocaleDateString()
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// A knowledge document, flattened out of the folder tree for the recent list.
interface KnowledgeDoc {
  title: string
  path: string
}

function flattenKnowledge(tree: KnowledgeDir[], prefix: string, out: KnowledgeDoc[]): KnowledgeDoc[] {
  for (const node of tree || []) {
    const dir = prefix ? `${prefix}/${node.dir}` : node.dir
    for (const file of node.files || []) out.push({ title: file.title || file.name, path: `${dir}/${file.name}` })
    flattenKnowledge(node.children || [], dir, out)
  }
  return out
}

/** The clay "could not load, retry" block each panel falls back to on its own. */
const PanelError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="twb-empty">
    <TriangleAlert size={26} />
    <p>{t('tw_load_failed')}</p>
    {message && <p className="twb-hint">{message}</p>}
    <button type="button" className="twb-btn" onClick={onRetry}>
      {t('tw_retry')}
    </button>
  </div>
)

const HomePage: React.FC<HomePageProps> = ({ baseUrl }) => {
  const navigate = useNavigate()
  const [board, setBoard] = useState<BoardSnapshot | null>(null)
  const [boardError, setBoardError] = useState('')
  const [artifacts, setArtifacts] = useState<{ id: string; title: string; when: string; icon: LucideIcon }[] | null>(null)
  const [artifactsError, setArtifactsError] = useState('')
  const [knowledge, setKnowledge] = useState<{ docs: KnowledgeDoc[]; pages: number } | null>(null)
  const [knowledgeError, setKnowledgeError] = useState('')
  // §7.4: today's lessons, the morning brief and the reminder settings.
  const [today, setToday] = useState<TeachingToday | null>(null)
  const [todayError, setTodayError] = useState('')
  const [settings, setSettings] = useState<TeachingSettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [settingsStatus, setSettingsStatus] = useState('')
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [preview, setPreview] = useState<ReminderPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  // First-run profile and the hero's greeting/motto. The profile is `null`
  // until the fetch answers, so the dialog never flashes for an onboarded
  // teacher.
  const [profile, setProfile] = useState<TeacherProfile | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [greeting, setGreeting] = useState<TeachingGreeting | null>(null)
  const [mottoBusy, setMottoBusy] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const copyTimer = useRef<number | null>(null)
  // A token per panel would be noise: one load bumps the token, and a reply
  // from a superseded load is dropped as a whole.
  const loadToken = useRef(0)

  const load = useCallback(async () => {
    const token = ++loadToken.current
    apiClient.setBaseUrl(baseUrl)
    setBoardError('')
    setArtifactsError('')
    setKnowledgeError('')
    setTodayError('')
    setSettingsError('')
    setProfileError('')

    // Each panel fails on its own: a missing artifact index must not blank the
    // board metrics.
    apiClient
      .getBoard()
      .then((data) => {
        if (token === loadToken.current) setBoard(data.board || null)
      })
      .catch((err) => {
        if (token === loadToken.current) setBoardError(errorText(err))
      })

    const scope = apiClient.getActiveAgentId() || 'all'
    apiClient
      .listArtifacts({ scope, limit: 5 })
      .then((data) => {
        if (token !== loadToken.current) return
        setArtifacts(
          (data.items || []).map((item) => ({
            id: String(item.id),
            title: item.title || item.file_name || item.rel_path || '',
            when: item.created_at ? dateTime(item.created_at) : '',
            icon: iconFor(item.kind),
          }))
        )
      })
      .catch((err) => {
        if (token === loadToken.current) setArtifactsError(errorText(err))
      })

    apiClient
      .getKnowledgeList()
      .then((data: KnowledgeList) => {
        if (token !== loadToken.current) return
        const root = (data.root_files || []).map((file) => ({ title: file.title || file.name, path: file.name }))
        const docs = root.concat(flattenKnowledge(data.tree || [], '', []))
        setKnowledge({ docs, pages: data.stats?.pages || docs.length })
      })
      .catch((err) => {
        if (token === loadToken.current) setKnowledgeError(errorText(err))
      })

    // The date is the client's own: the backend's today can differ from the
    // teacher's around midnight, and the brief is about the teacher's day.
    apiClient
      .getTeachingToday(todayISO())
      .then((data) => {
        if (token === loadToken.current) setToday(data)
      })
      .catch((err) => {
        if (token === loadToken.current) setTodayError(errorText(err))
      })

    apiClient
      .getTeachingSettings()
      .then((data) => {
        if (token === loadToken.current) setSettings(data)
      })
      .catch((err) => {
        if (token === loadToken.current) setSettingsError(errorText(err))
      })

    // The profile decides whether the first-run dialog opens; the greeting is
    // the hero's own copy and falls back to the time-of-day line on failure.
    apiClient
      .getTeachingProfile()
      .then((data) => {
        if (token === loadToken.current) setProfile(data)
      })
      .catch((err) => {
        if (token === loadToken.current) setProfileError(errorText(err))
      })

    apiClient
      .getTeachingGreeting()
      .then((data) => {
        if (token === loadToken.current) setGreeting(data)
      })
      .catch(() => {
        // The static time-of-day greeting is the fallback; no error banner.
      })
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  // A copy confirmation should not outlive the page or pile up timers.
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    []
  )

  const copyDigest = async () => {
    const text = today?.digest_text || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus(t('tw_digest_copied'))
    } catch (err) {
      setCopyStatus(tf('tw_digest_copy_failed', { msg: errorText(err) }))
    }
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyStatus(''), 4000)
  }

  const patchSettings = (patch: Partial<TeachingSettings>) =>
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))

  // §7.4: the settings only take effect once the scheduler has been re-laid,
  // so the save is PUT + sync, and only then is it reported as done.
  const saveSettings = async () => {
    if (!settings || settingsBusy) return
    setSettingsBusy(true)
    setSettingsError('')
    setSettingsStatus('')
    try {
      await apiClient.saveTeachingSettings(settings)
      await apiClient.syncTeachingReminders()
      setSettingsStatus(t('tw_rem_saved'))
      // The brief's wording depends on these settings, so fetch it again.
      const fresh = await apiClient.getTeachingToday(todayISO()).catch(() => null)
      if (fresh) {
        setToday(fresh)
        setTodayError('')
      }
      setPreview(null)
    } catch (err) {
      setSettingsStatus('')
      setSettingsError(tf('tw_rem_save_failed', { msg: errorText(err) }))
    } finally {
      setSettingsBusy(false)
    }
  }

  const loadPreview = async () => {
    if (previewBusy) return
    setPreviewBusy(true)
    setSettingsError('')
    try {
      setPreview(await apiClient.getTeachingRemindersPreview())
    } catch (err) {
      setSettingsError(tf('tw_rem_preview_failed', { msg: errorText(err) }))
    } finally {
      setPreviewBusy(false)
    }
  }

  const openTool = (id: string) => navigate(`/teaching?tool=${encodeURIComponent(id)}`)

  // The dialog and the settings card write the same document. A save that
  // fails leaves the dialog open with the backend's reason, so the button is
  // also the retry.
  const saveProfile = async (fields: TeacherProfileFields) => {
    if (profileBusy) return
    setProfileBusy(true)
    setProfileError('')
    try {
      await apiClient.saveTeachingProfile(fields)
      // Close the dialog from the fields just saved even if the refresh fails:
      // the write already succeeded, and a confirmation must not claim it did not.
      const base: TeacherProfile =
        profile ?? { name: '', subjects: [], classes: [], textbook: '', school: '', onboarded: false }
      setProfile({ ...base, ...fields, onboarded: true })
      const fresh = await apiClient.getTeachingProfile().catch(() => null)
      if (fresh) setProfile(fresh)
      const freshGreeting = await apiClient.getTeachingGreeting().catch(() => null)
      if (freshGreeting) setGreeting(freshGreeting)
      void load()
    } catch (err) {
      setProfileError(tf('tw_profile_save_failed', { msg: errorText(err) }))
    } finally {
      setProfileBusy(false)
    }
  }

  const changeMotto = async () => {
    if (mottoBusy) return
    setMottoBusy(true)
    try {
      setGreeting(await apiClient.getTeachingGreeting(true))
    } catch {
      // Keep the line already on screen; the next load asks again.
    } finally {
      setMottoBusy(false)
    }
  }
  const counts = board?.counts
  // Local calendar date, not ISO: a task is late by the teacher's day, and
  // toISOString() would call 00:30 in UTC+8 yesterday.
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const hour = now.getHours()

  return (
    <div id="twb-home" className="flex-1 flex flex-col min-h-0">
      <OnboardingDialog
        open={Boolean(profile && !profile.onboarded)}
        initial={profile}
        busy={profileBusy}
        error={profileError}
        onSave={(fields) => void saveProfile(fields)}
      />
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-hero">
            <div className="twb-hero-copy">
              <span className="twb-eyebrow">
                <PenLine size={13} />
                <span>{t('tw_home_eyebrow')}</span>
              </span>
              <h1 className="twb-hero-title">
                {greeting?.greeting ||
                  t(hour < 12 ? 'tw_home_hi_morning' : hour < 18 ? 'tw_home_hi_afternoon' : 'tw_home_hi_evening')}
              </h1>
              <div className="twb-hero-motto">
                <Lightbulb size={15} />
                <p>{greeting?.motto || t('tw_greeting_pending')}</p>
                <button
                  type="button"
                  className="twb-link"
                  disabled={mottoBusy}
                  onClick={() => void changeMotto()}
                >
                  {mottoBusy ? <Loader2 size={13} className="twb-spin" /> : <RefreshCw size={13} />}
                  <span>{t('tw_greeting_change')}</span>
                </button>
              </div>
              <p className="twb-lede">{t('tw_home_lede')}</p>
              <div className="twb-hero-actions">
                <button type="button" className="twb-btn twb-btn-primary" onClick={() => navigate('/teaching')}>
                  <PenLine size={15} />
                  <span>{t('tw_home_start')}</span>
                </button>
                <button type="button" className="twb-btn" onClick={() => navigate('/board')}>
                  <ClipboardList size={15} />
                  <span>{t('tw_home_open_board')}</span>
                </button>
              </div>
            </div>
            <div className="twb-hero-date">
              <span className="twb-hero-date-label">{t('tw_home_today')}</span>
              <b>{dateLine()}</b>
            </div>
          </header>

          <section aria-labelledby="twb-home-metrics">
            <h2 id="twb-home-metrics" className="twb-sr-only">
              {t('tw_home_overview')}
            </h2>
            <div className="twb-metrics">
              <div className="twb-metric twb-metric-a">
                <span className="twb-metric-label">{t('tw_metric_todo')}</span>
                <b>{counts?.todo ?? 0}</b>
                <ClipboardList size={18} />
              </div>
              <div className="twb-metric twb-metric-b">
                <span className="twb-metric-label">{t('tw_metric_doing')}</span>
                <b>{counts?.doing ?? 0}</b>
                <Loader2 size={18} />
              </div>
              <div className="twb-metric twb-metric-c">
                <span className="twb-metric-label">{t('tw_metric_done')}</span>
                <b>{counts?.done ?? 0}</b>
                <ClipboardList size={18} />
              </div>
            </div>
            {boardError && <p className="twb-status is-error mt-2">{boardError}</p>}
          </section>

          <section className="twb-home-dash" aria-label={t('tw_home_overview')}>
            <div className="twb-home-grid">
              <section className="twb-card twb-home-cell twb-home-lessons" aria-labelledby="twb-today-lessons">
                <div className="twb-card-head">
                  <h2 id="twb-today-lessons">{t('tw_today_title')}</h2>
                  <button type="button" className="twb-link" onClick={() => navigate('/timetable')}>
                    <span>{t('tw_today_open_tt')}</span>
                    <ArrowRight size={13} />
                  </button>
                </div>
                {today ? (
                  today.lessons.length ? (
                    <>
                      <div className="twb-lessons">
                        {today.lessons.map((lesson) => (
                          <button
                            key={`${lesson.period}-${lesson.class_id}`}
                            type="button"
                            className="twb-lesson"
                            title={lesson.topic || undefined}
                            onClick={() => navigate('/timetable')}
                          >
                            <span className="twb-lesson-time">
                              <b>{lesson.start || tf('tw_tt_period_n', { n: lesson.period })}</b>
                              {lesson.end && <small>{lesson.end}</small>}
                            </span>
                            <i
                              className={`twb-dot${lesson.mine ? ' is-mine' : ''}`}
                              title={lesson.mine ? t('tw_today_mine') : t('tw_tt_other')}
                              aria-hidden="true"
                            />
                            <span className="twb-lesson-what">
                              <b>{lesson.class_name || t('tw_tt_unknown_class')}</b>
                              <small>
                                {[
                                  lesson.subject,
                                  t(`tw_kind_${lesson.kind}`),
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </small>
                            </span>
                            {lesson.topic && <em className="twb-lesson-topic">{lesson.topic}</em>}
                          </button>
                        ))}
                      </div>
                      <p className="twb-footnote">
                        {tf('tw_today_lessons_n', { n: today.lessons.length })}
                      </p>
                    </>
                  ) : (
                    <div className="twb-empty">
                      <CalendarDays size={26} />
                      <p>{t('tw_today_empty')}</p>
                      <button type="button" className="twb-btn" onClick={() => navigate('/timetable')}>
                        {t('tw_today_open_tt')}
                      </button>
                    </div>
                  )
                ) : todayError ? (
                  <PanelError message={todayError} onRetry={() => void load()} />
                ) : (
                  <p className="twb-loading">{t('tw_loading')}</p>
                )}
              </section>

              <section className="twb-card twb-home-cell twb-home-digest" aria-labelledby="twb-today-digest">
                <div className="twb-card-head">
                  <h2 id="twb-today-digest">{t('tw_digest_title')}</h2>
                  <button
                    type="button"
                    className="twb-link"
                    disabled={!today?.digest_text}
                    onClick={() => void copyDigest()}
                  >
                    <Copy size={13} />
                    <span>{t('tw_digest_copy')}</span>
                  </button>
                </div>
                {today ? (
                  today.digest_text ? (
                    <pre className="twb-digest">{today.digest_text}</pre>
                  ) : (
                    <div className="twb-empty">
                      <FileText size={26} />
                      <p>{t('tw_digest_empty')}</p>
                    </div>
                  )
                ) : todayError ? (
                  <PanelError message={todayError} onRetry={() => void load()} />
                ) : (
                  <p className="twb-loading">{t('tw_loading')}</p>
                )}
                {copyStatus && <p className="twb-status">{copyStatus}</p>}
              </section>

              <section className="twb-card twb-home-cell twb-home-rem" aria-labelledby="twb-today-reminders">
                <div className="twb-card-head">
                  <h2 id="twb-today-reminders">{t('tw_rem_title')}</h2>
                </div>
                {settings ? (
                  <>
                    <div className="twb-rem">
                      <label className="twb-check">
                        <input
                          type="checkbox"
                          checked={settings.morning.enabled}
                          onChange={(e) =>
                            patchSettings({
                              morning: { ...settings.morning, enabled: e.target.checked },
                            })
                          }
                        />
                        <span>{t('tw_rem_morning')}</span>
                      </label>
                      <label className="twb-field twb-field-inline">
                        <span>{t('tw_rem_morning_time')}</span>
                        <input
                          className="twb-input twb-rem-time"
                          type="time"
                          value={settings.morning.time}
                          disabled={!settings.morning.enabled}
                          onChange={(e) =>
                            patchSettings({
                              morning: { ...settings.morning, time: e.target.value },
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="twb-rem">
                      <label className="twb-check">
                        <input
                          type="checkbox"
                          checked={settings.lesson.enabled}
                          onChange={(e) =>
                            patchSettings({
                              lesson: { ...settings.lesson, enabled: e.target.checked },
                            })
                          }
                        />
                        <span>{t('tw_rem_lesson')}</span>
                      </label>
                      <label className="twb-field twb-field-inline">
                        <span>{t('tw_rem_lesson_minutes')}</span>
                        <input
                          className="twb-input twb-rem-min"
                          type="number"
                          min={1}
                          max={60}
                          step={5}
                          value={settings.lesson.minutes}
                          disabled={!settings.lesson.enabled}
                          onChange={(e) =>
                            patchSettings({
                              lesson: { ...settings.lesson, minutes: Number(e.target.value) },
                            })
                          }
                        />
                      </label>
                    </div>
                    <p className="twb-hint">{t('tw_rem_hint')}</p>
                    <div className="twb-rem-actions">
                      <button
                        type="button"
                        className="twb-btn twb-btn-primary"
                        disabled={settingsBusy}
                        onClick={() => void saveSettings()}
                      >
                        {settingsBusy ? <Loader2 size={14} className="twb-spin" /> : null}
                        <span>{t('tw_rem_save')}</span>
                      </button>
                      <button
                        type="button"
                        className="twb-btn"
                        disabled={previewBusy}
                        onClick={() => void loadPreview()}
                      >
                        {t('tw_rem_preview')}
                      </button>
                    </div>
                    {settingsStatus && <p className="twb-status">{settingsStatus}</p>}
                    {settingsError && <p className="twb-status is-error">{settingsError}</p>}
                    {preview && (
                      <div className="twb-rem-preview">
                        <h3>{t('tw_rem_preview_title')}</h3>
                        <pre className="twb-digest">{preview.digest || t('tw_digest_empty')}</pre>
                        <h3>{t('tw_rem_preview_lesson')}</h3>
                        <pre className="twb-digest">
                          {preview.lesson || t('tw_rem_preview_none')}
                        </pre>
                      </div>
                    )}
                  </>
                ) : settingsError ? (
                  <PanelError message={settingsError} onRetry={() => void load()} />
                ) : (
                  <p className="twb-loading">{t('tw_loading')}</p>
                )}
              </section>

              <section className="twb-card twb-home-cell twb-home-board" aria-labelledby="twb-home-board">
                <div className="twb-card-head">
                  <h2 id="twb-home-board">{t('tw_home_board')}</h2>
                  <button type="button" className="twb-link" onClick={() => navigate('/board')}>
                    <span>{t('tw_home_board_all')}</span>
                    <ArrowRight size={13} />
                  </button>
                </div>
                {board ? (
                  board.columns.length ? (
                    <div className="twb-mini-board">
                      {board.columns.map((column) => (
                        <div className="twb-mini-col" key={column.status}>
                          <h3>
                            <span>{t(`tw_status_${column.status}`)}</span>
                            <span>{column.tasks.length}</span>
                          </h3>
                          {column.tasks.length ? (
                            column.tasks.slice(0, 3).map((task) => (
                              <button
                                key={task.id}
                                type="button"
                                className={`twb-mini-task${
                                  task.due && task.status !== 'done' && task.due < todayStr ? ' is-overdue' : ''
                                }`}
                                title={task.title}
                                onClick={() => navigate('/board')}
                              >
                                {task.title}
                              </button>
                            ))
                          ) : (
                            <div className="twb-mini-empty">{t('tw_board_empty_col')}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="twb-empty">
                      <ClipboardList size={26} />
                      <p>{t('tw_home_empty_board')}</p>
                      <button type="button" className="twb-btn twb-btn-primary" onClick={() => navigate('/board')}>
                        {t('tw_board_new')}
                      </button>
                    </div>
                  )
                ) : boardError ? (
                  <PanelError message={boardError} onRetry={() => void load()} />
                ) : (
                  <p className="twb-loading">{t('tw_loading')}</p>
                )}
              </section>

              <section className="twb-card twb-home-cell twb-home-artifacts" aria-labelledby="twb-home-artifacts">
                <div className="twb-card-head">
                  <h2 id="twb-home-artifacts">{t('tw_home_artifacts')}</h2>
                  <button type="button" className="twb-link" onClick={() => navigate('/artifacts')}>
                    <span>{t('tw_home_board_all')}</span>
                    <ArrowRight size={13} />
                  </button>
                </div>
                {artifacts ? (
                  artifacts.length ? (
                    <div className="twb-list">
                      {artifacts.map((item) => {
                        const Icon = item.icon
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className="twb-list-item"
                            onClick={() => navigate('/artifacts')}
                          >
                            <Icon size={15} />
                            <span>{item.title}</span>
                            {item.when && <small>{item.when}</small>}
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="twb-empty">
                      <Box size={26} />
                      <p>{t('tw_home_empty_artifacts')}</p>
                    </div>
                  )
                ) : artifactsError ? (
                  <PanelError message={artifactsError} onRetry={() => void load()} />
                ) : (
                  <p className="twb-loading">{t('tw_loading')}</p>
                )}
              </section>

              <section className="twb-card twb-home-cell twb-home-knowledge" aria-labelledby="twb-home-knowledge">
                <div className="twb-card-head">
                  <h2 id="twb-home-knowledge">{t('tw_home_knowledge')}</h2>
                  <button type="button" className="twb-link" onClick={() => navigate('/knowledge')}>
                    <span>{t('tw_home_knowledge_all')}</span>
                    <ArrowRight size={13} />
                  </button>
                </div>
                {knowledge ? (
                  knowledge.docs.length ? (
                    <>
                      <div className="twb-list">
                        {knowledge.docs.slice(0, 5).map((doc) => (
                          <button
                            key={doc.path}
                            type="button"
                            className="twb-list-item"
                            title={doc.path}
                            onClick={() => navigate('/knowledge')}
                          >
                            <FileText size={15} />
                            <span>{doc.title}</span>
                          </button>
                        ))}
                      </div>
                      <p className="twb-footnote">{tf('tw_knowledge_pages', { n: knowledge.pages })}</p>
                    </>
                  ) : (
                    <div className="twb-empty">
                      <BookOpen size={26} />
                      <p>{t('tw_home_empty_knowledge')}</p>
                    </div>
                  )
                ) : knowledgeError ? (
                  <PanelError message={knowledgeError} onRetry={() => void load()} />
                ) : (
                  <p className="twb-loading">{t('tw_loading')}</p>
                )}
              </section>
            </div>
          </section>

          <section aria-labelledby="twb-home-quick">
            <div className="twb-section-head">
              <div>
                <h2 id="twb-home-quick">{t('tw_quick_title')}</h2>
                <p>{t('tw_quick_desc')}</p>
              </div>
            </div>
            <div className="twb-tools">
              {TOOLS.map((tool) => {
                const Icon = tool.icon
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className={`twb-tool ${tool.tone}`}
                    onClick={() => openTool(tool.id)}
                  >
                    <span className="twb-tool-ico">
                      <Icon size={18} />
                    </span>
                    <b>{t(tool.labelKey)}</b>
                    <span>{t(tool.descKey)}</span>
                  </button>
                )
              })}
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}

export default HomePage
