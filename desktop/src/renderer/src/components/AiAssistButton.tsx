// The 教学 pages' corner assistant: a right-hand drawer that continues one
// conversation with the Agent on the page it was opened from.
//
// The drawer owns its prompt policy — read the page's teaching tool first,
// write only when the request needs it, and close with one line saying what
// changed — so every page gets the same contract and only supplies its scene,
// its page key and the teaching tool to read. The exchange is a real session
// (`ai-<page>`), so closing and reopening the drawer shows the same history,
// and it is listed under 对话.
//
// The layout is a chat surface: header, the scrolling timeline, the day's
// suggested questions as pills above the composer, and the composer itself
// pinned to the drawer's bottom edge. Suggestions come from the backend's
// per-page model call and are only shown before the first message; tapping one
// fills the input rather than sending, so the teacher can edit it first.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, Sparkles, Square, X } from 'lucide-react'
import { t } from '../i18n'
import apiClient from '../api/client'
import EmbeddedChat from './EmbeddedChat'
import { useChatStore } from '../store/chatStore'

export interface AiAssistButtonProps {
  /** Page identity for the conversation, e.g. `classes`. */
  pageKey: string
  /** Teaching tool the Agent must read first, e.g. `class_list`. */
  dataTool: string
  /** One line saying what this page's assistant is for. */
  scene: string
}

/** The read → maybe write → one-line summary contract every page shares. */
function buildPrompt(dataTool: string, request: string): string {
  return [
    request,
    '',
    '要求：',
    `1. 先调用教学工具 ${dataTool} 读取现有数据，按真实数据回答，不要编造。`,
    '2. 只有用户明确要求改动时才写入；写入前核对班级与字段，避免覆盖别人刚改的内容。',
    '3. 最后用一句话说明改了什么；没有改动就说「本次未修改数据」。',
  ].join('\n')
}

const MAX_INPUT_HEIGHT = 100

const AiAssistButton: React.FC<AiAssistButtonProps> = ({ pageKey, dataTool, scene }) => {
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sessionId = `ai-${pageKey}`
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const running = useChatStore((s) => s.getSession(sessionId).isStreaming)
  const hasMessages = useChatStore((s) => (s.sessions[sessionId]?.messages.length ?? 0) > 0)

  // A textarea that grows with its draft, capped at four lines.
  const autoSize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }

  useEffect(() => {
    if (open) autoSize()
  }, [open, request])

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

  const fill = (text: string) => {
    setRequest(text)
    window.requestAnimationFrame(() => {
      autoSize()
      inputRef.current?.focus()
    })
  }

  const run = () => {
    const text = request.trim()
    if (!text || running) return
    setRequest('')
    void send(sessionId, buildPrompt(dataTool, text), [])
    window.requestAnimationFrame(autoSize)
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
          >
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
              <textarea
                ref={inputRef}
                className="twb-ai-input"
                rows={1}
                value={request}
                placeholder={t('ai_input_ph')}
                aria-label={t('ai_input_ph')}
                onChange={(e) => setRequest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    run()
                  }
                }}
              />
              <button
                type="button"
                className="twb-ai-send"
                title={running ? t('ai_stop') : t('ai_send')}
                aria-label={running ? t('ai_stop') : t('ai_send')}
                disabled={!running && !request.trim()}
                onClick={() => {
                  if (running) void cancel(sessionId)
                  else run()
                }}
              >
                {running ? <Square size={13} /> : <ArrowUp size={16} />}
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  )
}

export default AiAssistButton
