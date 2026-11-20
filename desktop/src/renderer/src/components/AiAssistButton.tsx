// The 教学 pages' corner assistant: a right-hand drawer that continues one
// conversation with the Agent on the page it was opened from.
//
// The drawer owns its prompt policy — read the page's JSON files first, write
// only when the request needs it, and close with one line saying what changed —
// so every page gets the same contract and only supplies its scene, its page
// key and the files the page owns. (There is no "teaching tool" for the agent
// to call; the workspace files are the data.) The exchange is a real session
// (`ai-<page>`), so closing and reopening the drawer shows the same history,
// and it is listed under 对话.
//
// The layout is a chat surface: header, the scrolling timeline, the day's
// suggested questions as pills above the composer, and the composer itself
// pinned to the drawer's bottom edge. Suggestions come from the backend's
// per-page model call and are only shown before the first message; tapping one
// fills the input rather than sending, so the teacher can edit it first.
import React, { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import apiClient from '../api/client'
import ChatInput, { type ChatInputHandle } from './ChatInput'
import EmbeddedChat from './EmbeddedChat'
import { useChatStore } from '../store/chatStore'
import type { Attachment } from '../types'

export interface AiAssistButtonProps {
  /** Page identity for the conversation, e.g. `classes`. */
  pageKey: string
  /**
   * Data files under the workspace this page owns, e.g. ``teaching/classes.json``.
   * The agent has no "teaching tool" to call — these files are the source.
   */
  dataFiles: string[]
  /** What the page can actually do today, for the drawer's subtitle. */
  scene: string
}

/** The read → maybe write → one-line summary contract every page shares. */
function buildPrompt(dataFiles: string[], request: string): string {
  return [
    request,
    '',
    '要求：',
    `1. 先读这些文件拿到真实数据：${dataFiles.map((f) => `~/cow/${f}`).join('、')}。` +
      '文件不存在或为空就直说「目前还没有数据」，不要编造，也不要说「接口不可用」。',
    '2. 只有用户明确要求改动时才写入；写入前核对班级与字段，避免覆盖别人刚改的内容。',
    '3. 写文件用整份 JSON 覆盖时，先读出来再改，不要凭记忆重建。',
    '4. 最后用一句话说明改了什么；没有改动就说「本次未修改数据」。',
  ].join('\n')
}

// Drawer width: the teacher drags the left edge. Wide enough for the chat
// composer's chip row, never wider than most of the window.
const MIN_DRAWER_WIDTH = 380
const MAX_DRAWER_WIDTH = 940
const DEFAULT_DRAWER_WIDTH = 470
const DRAWER_WIDTH_KEY = 'twb.aiDrawer.width'

function clampDrawerWidth(width: number): number {
  const viewportCap = Math.round(window.innerWidth * 0.92)
  return Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, viewportCap, Math.round(width)))
}

const AiAssistButton: React.FC<AiAssistButtonProps> = ({ pageKey, dataFiles, scene }) => {
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [width, setWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem(DRAWER_WIDTH_KEY))
    return clampDrawerWidth(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_DRAWER_WIDTH)
  })
  const inputRef = useRef<ChatInputHandle>(null)
  const dragRef = useRef<{ x: number; width: number } | null>(null)
  const navigate = useNavigate()
  const sessionId = `ai-${pageKey}`
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const clearContext = useChatStore((s) => s.clearContext)
  const running = useChatStore((s) => s.getSession(sessionId).isStreaming)
  const hasMessages = useChatStore((s) => (s.sessions[sessionId]?.messages.length ?? 0) > 0)

  // Remember the dragged width so the next open starts where the teacher left it.
  useEffect(() => {
    window.localStorage.setItem(DRAWER_WIDTH_KEY, String(width))
  }, [width])

  // Escape closes the drawer, the same as the clay dialogs.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Each open asks for the page's prompts; the backend answers from the day's
  // cache, so only the first open of a day waits on the model. A failure hides
  // the pill row instead of showing permanent placeholders.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSuggestionsLoading(true)
    apiClient
      .getTeachingSuggestions(pageKey)
      .then((items) => {
        if (!cancelled) setSuggestions(items)
      })
      .catch(() => {
        if (!cancelled) setSuggestions([])
      })
      .finally(() => {
        if (!cancelled) setSuggestionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, pageKey])

  // A pill only fills the composer: the teacher edits it (class, unit, counts)
  // before sending.
  const fill = (text: string) => {
    inputRef.current?.(text, [])
  }

  // Same composer as the chat page (attachments, images, model chip, `/skill`),
  // but every message carries the page contract and the transcript keeps what
  // the teacher actually typed.
  const handleSend = (message: string, attachments: Attachment[], display?: string) => {
    void send(sessionId, buildPrompt(dataFiles, message), attachments, display ?? message)
  }

  return (
    <>
      <button
        type="button"
        className="twb-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Sparkles size={15} />
        <span>{t('ai_assistant')}</span>
      </button>

      {open && (
        <div className="twb-ai-layer">
          <div className="twb-ai-scrim" onClick={() => setOpen(false)} />
          <aside
            className="twb-ai-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="twb-ai-title"
            style={{ width: `${width}px` }}
          >
            <div
              className="twb-ai-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('ai_resize')}
              aria-valuenow={width}
              aria-valuemin={MIN_DRAWER_WIDTH}
              aria-valuemax={MAX_DRAWER_WIDTH}
              title={t('ai_resize')}
              onDoubleClick={() => setWidth(clampDrawerWidth(DEFAULT_DRAWER_WIDTH))}
              onPointerDown={(e) => {
                dragRef.current = { x: e.clientX, width }
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                const drag = dragRef.current
                if (!drag) return
                setWidth(clampDrawerWidth(drag.width + (drag.x - e.clientX)))
              }}
              onPointerUp={(e) => {
                dragRef.current = null
                e.currentTarget.releasePointerCapture(e.pointerId)
              }}
              onPointerCancel={() => {
                dragRef.current = null
              }}
            />
            <header className="twb-ai-head">
              <div>
                <h2 id="twb-ai-title">{t('ai_assistant')}</h2>
                <p>{scene}</p>
              </div>
              <button
                type="button"
                className="twb-icon-btn"
                title={t('ai_close')}
                aria-label={t('ai_close')}
                onClick={() => setOpen(false)}
              >
                <X size={15} />
              </button>
            </header>

            <div className="twb-ai-chat">
              <EmbeddedChat sessionId={sessionId} />
            </div>

            {!hasMessages && (suggestionsLoading || suggestions.length > 0) && (
              <div
                className="twb-ai-suggestions"
                aria-label={t('ai_suggestions')}
                aria-busy={suggestionsLoading}
              >
                {suggestionsLoading
                  ? [0, 1, 2].map((index) => (
                      <span
                        key={index}
                        className="twb-ai-chip twb-ai-chip-skeleton"
                        aria-hidden="true"
                      />
                    ))
                  : suggestions.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className="twb-ai-chip"
                        onClick={() => fill(item)}
                      >
                        {item}
                      </button>
                    ))}
              </div>
            )}

            <div className="twb-ai-composer">
              <ChatInput
                ref={inputRef}
                sessionId={sessionId}
                isStreaming={running}
                hideNewChat
                onSend={handleSend}
                onNewChat={() => {}}
                onStop={() => void cancel(sessionId)}
                onClearContext={() => void clearContext(sessionId)}
                onAdjustContext={() => {
                  setOpen(false)
                  navigate('/agents')
                }}
              />
            </div>
          </aside>
        </div>
      )}
    </>
  )
}

export default AiAssistButton
