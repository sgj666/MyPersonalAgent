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
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { t, tf, getLang } from '../i18n'
import apiClient from '../api/client'
import { iconFor } from '../lib/fileKind'
import { dateTime } from './artifacts/format'
import type { BoardSnapshot, KnowledgeDir, KnowledgeList } from '../types'

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
  // A token per panel would be noise: one load bumps the token, and a reply
  // from a superseded load is dropped as a whole.
  const loadToken = useRef(0)

  const load = useCallback(async () => {
    const token = ++loadToken.current
    apiClient.setBaseUrl(baseUrl)
    setBoardError('')
    setArtifactsError('')
    setKnowledgeError('')

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
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  const openTool = (id: string) => navigate(`/teaching?tool=${encodeURIComponent(id)}`)
  const counts = board?.counts
  // Local calendar date, not ISO: a task is late by the teacher's day, and
  // toISOString() would call 00:30 in UTC+8 yesterday.
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const hour = now.getHours()

  return (
    <div id="twb-home" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-hero">
            <div className="twb-hero-copy">
              <span className="twb-eyebrow">
                <PenLine size={13} />
                <span>{t('tw_home_eyebrow')}</span>
              </span>
              <h1 className="twb-hero-title">
                <span>{t(hour < 12 ? 'tw_home_hi_morning' : hour < 18 ? 'tw_home_hi_afternoon' : 'tw_home_hi_evening')}</span>
                <br />
                <span className="twb-hl">{t('tw_home_question')}</span>
              </h1>
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

          <div className="twb-home-grid">
            <section className="twb-card twb-home-board" aria-labelledby="twb-home-board">
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

            <section className="twb-card" aria-labelledby="twb-home-artifacts">
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

            <section className="twb-card" aria-labelledby="twb-home-knowledge">
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
        </div>
      </div>
    </div>
  )
}

export default HomePage
