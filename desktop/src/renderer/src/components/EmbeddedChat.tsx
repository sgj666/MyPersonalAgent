// A real conversation embedded in a tool surface.
//
// The tool pages used to stream one answer into their own local string. This
// renders the chat page's own timeline instead: the same user/assistant
// bubbles, tool steps and file cards, backed by a stable session id so the
// exchange is saved and listed under 对话 like any other conversation.

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import MessageBubble from './MessageBubble'
import ChatTimeline from './ChatTimeline'
import ChatInput from './ChatInput'
import apiClient from '../api/client'
import { useChatStore } from '../store/chatStore'
import { sessionOwner, useSessionStore } from '../store/sessionStore'
import { replyText } from '../lib/teaching'
import type { Attachment } from '../types'
import { getLang, t } from '../i18n'

export interface EmbeddedChatProps {
  /** Stable per-surface id, e.g. `teach-plan` or `ai-classes`. */
  sessionId: string
  className?: string
  /**
   * Draw the chat page's own composer under the timeline — attachments,
   * `/` commands, `@` files, model chip, voice. Same bar as 对话, so a page
   * assistant and the chat page behave alike.
   */
  composer?: boolean
  /** Placeholder for that composer (falls back to the chat page's own). */
  placeholder?: string
  /**
   * Wrap what the agent receives, leaving the transcript showing what was
   * typed — how a page prepends the facts it owns to a follow-up question.
   */
  wrapMessage?: (message: string) => string
  /**
   * Called once when a streamed answer finishes, with its text — how a surface
   * reads the JSON a Skill returned without owning the send. Not called for an
   * errored turn, a cancellation, or restored history.
   */
  onReply?: (text: string) => void
}

// A fresh session only appears in the session list once the backend has its
// first turn, so the title pass retries briefly instead of renaming a row that
// isn't there yet.
const TITLE_RETRIES = 8
const TITLE_RETRY_MS = 900

const TEACH_TITLE_KEYS: Record<string, string> = {
  plan: 'tw_tool_plan',
  courseware: 'tw_tool_courseware',
  card: 'tw_tool_card',
  advice: 'tw_tool_advice',
  schedule: 'tw_tool_schedule',
}

const AI_TITLE_KEYS: Record<string, string> = {
  classes: 'ai_title_classes',
  timetable: 'ai_title_timetable',
  progress: 'ai_title_progress',
  homework: 'ai_title_homework',
  scores: 'ai_title_scores',
}

/** `教案生成 · 8月12日` — short enough to read in the session list. */
function readableTitle(sessionId: string): string {
  const at = sessionId.indexOf('-')
  if (at < 0) return ''
  const prefix = sessionId.slice(0, at)
  const key = sessionId.slice(at + 1)
  const keys = prefix === 'teach' ? TEACH_TITLE_KEYS : prefix === 'ai' ? AI_TITLE_KEYS : undefined
  const labelKey = keys?.[key]
  if (!labelKey) return ''
  const d = new Date()
  const day =
    getLang() === 'zh'
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${t(labelKey)} · ${day}`
}

/**
 * The backend titles a fresh session with its first prompt (sometimes cut to a
 * prefix). Such a title is replaced; a name someone chose is left alone.
 */
function isPromptTitle(title: string, prompt: string): boolean {
  const current = (title || '').trim()
  if (!current) return true
  return current === prompt || (current.length >= 8 && prompt.startsWith(current))
}

const EmbeddedChat: React.FC<EmbeddedChatProps> = ({
  sessionId,
  className,
  composer = false,
  placeholder,
  wrapMessage,
  onReply,
}) => {
  // The session object is the stable snapshot; deriving `[]` inside the
  // selector would hand useSyncExternalStore a fresh array every read.
  const session = useChatStore((s) => s.sessions[sessionId])
  const messages = session?.messages ?? []
  const isStreaming = session?.isStreaming ?? false
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const clearContext = useChatStore((s) => s.clearContext)
  const ensureSession = useChatStore((s) => s.ensureSession)
  const loadHistory = useChatStore((s) => s.loadHistory)
  const navigate = useNavigate()

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const titledRef = useRef('')

  // Restore the conversation whenever this surface opens.
  useEffect(() => {
    ensureSession(sessionId)
    const current = useChatStore.getState().sessions[sessionId]
    if (!current || current.historyLoaded || current.isStreaming) return
    void loadHistory(sessionId, 1).then((ok) => {
      if (!ok) console.warn('[EmbeddedChat] history unavailable', sessionId)
    })
  }, [sessionId, ensureSession, loadHistory])

  // Give the session a readable list title once its first turn exists, so 对话
  // doesn't show the whole prompt. Also refreshes the list, which is what makes
  // the new conversation show up there at all.
  const firstPrompt = useMemo(
    () => messages.find((m) => m.role === 'user')?.content?.trim() || '',
    [messages]
  )
  useEffect(() => {
    if (!firstPrompt || titledRef.current === sessionId) return
    let cancelled = false
    let timer: number | undefined
    let attempt = 0
    const attemptTitle = async () => {
      // Already listed with a name of its own: nothing to title or refresh.
      const listed = useSessionStore.getState().sessions.find((s) => s.session_id === sessionId)
      if (listed && !isPromptTitle(listed.title || '', firstPrompt)) {
        titledRef.current = sessionId
        return
      }
      try {
        await useSessionStore.getState().loadSessions(1)
      } catch (err) {
        console.warn('[EmbeddedChat] session refresh failed', err)
      }
      if (cancelled) return
      const row = useSessionStore.getState().sessions.find((s) => s.session_id === sessionId)
      if (row) {
        if (!isPromptTitle(row.title || '', firstPrompt)) {
          titledRef.current = sessionId
          return
        }
        const title = readableTitle(sessionId)
        if (!title) {
          titledRef.current = sessionId
          return
        }
        try {
          const res = await apiClient.renameSession(sessionId, title, sessionOwner(sessionId) || undefined)
          if (res.status === 'success') {
            if (cancelled) return
            useSessionStore.setState((s) => ({
              sessions: s.sessions.map((x) => (x.session_id === sessionId ? { ...x, title } : x)),
            }))
            titledRef.current = sessionId
            return
          }
        } catch (err) {
          console.warn('[EmbeddedChat] title update failed', err)
        }
      }
      if (cancelled || ++attempt >= TITLE_RETRIES) return
      timer = window.setTimeout(() => void attemptTitle(), TITLE_RETRY_MS)
    }
    void attemptTitle()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sessionId, firstPrompt])

  // Hand a finished answer to the surface that asked for one. Only the
  // true→false edge of `isStreaming` counts, so history loads stay silent.
  const onReplyRef = useRef(onReply)
  onReplyRef.current = onReply
  const wasStreaming = useRef(false)
  useEffect(() => {
    const settled = wasStreaming.current && !isStreaming
    wasStreaming.current = isStreaming
    if (!settled || !onReplyRef.current) return
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    if (!last || last.error || last.isCancelled) return
    onReplyRef.current(replyText(last))
  }, [isStreaming, messages])

  // Count + last timestamp, plus how many questions have a persisted seq: a
  // sent question keeps the length unchanged when the backend assigns its seq,
  // and that is exactly when the navigator index gains the new turn.
  const persistedUserSeqs = messages.reduce((n, m) => n + (m.role === 'user' && m.userSeq != null ? 1 : 0), 0)
  const revision = `${messages.length}:${persistedUserSeqs}:${messages.length ? messages[messages.length - 1].timestamp : 0}`

  // A new surface starts at its newest message.
  useEffect(() => {
    stickToBottomRef.current = true
  }, [sessionId])

  // Follow the reply while it streams; holding the position when the reader
  // has scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, revision, isStreaming])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  const handleMediaLoad = useCallback(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [])

  // The composer hands over the message and its attachments; ChatInput has
  // already expanded any `/skill-name` into the instruction the agent gets.
  const handleSend = useCallback(
    (message: string, attachments: Attachment[], display?: string) => {
      stickToBottomRef.current = true
      void send(sessionId, wrapMessage ? wrapMessage(message) : message, attachments, display ?? message)
    },
    [send, sessionId, wrapMessage]
  )

  // Each message's turn: the seq of the question that opened it, for the file
  // cards it shows.
  const turnSeqs = useMemo(() => {
    let turn: number | null = null
    return messages.map((m) => {
      if (m.role === 'user') turn = m.userSeq ?? null
      return turn
    })
  }, [messages])

  return (
    <div className={`twb-embed relative flex flex-col min-h-0${className ? ` ${className}` : ''}`}>
      <div
        ref={scrollRef}
        className="twb-embed-scroll relative min-h-0 flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        {messages.length === 0 ? (
          <div className="twb-embed-empty" aria-live="polite">
            <p>{t('embed_empty')}</p>
          </div>
        ) : (
          <div className="chat-column py-2">
            {messages.map((msg, i) =>
              msg.kind === 'divider' ? (
                <div key={msg.id} className="flex items-center gap-3 px-4 py-3 text-content-tertiary">
                  <span
                    className="h-px flex-1"
                    style={{ background: 'linear-gradient(to right, transparent, var(--border-strong), transparent)' }}
                  />
                  <span className="whitespace-nowrap text-xs">{msg.content || t('context_cleared')}</span>
                  <span
                    className="h-px flex-1"
                    style={{ background: 'linear-gradient(to right, transparent, var(--border-strong), transparent)' }}
                  />
                </div>
              ) : (
                <div
                  key={msg.id}
                  className="chat-message-row"
                  data-user-seq={msg.role === 'user' && msg.userSeq != null ? msg.userSeq : undefined}
                >
                  <MessageBubble
                    message={msg}
                    onMediaLoad={handleMediaLoad}
                    turnSeq={turnSeqs[i]}
                    lang={getLang()}
                  />
                </div>
              )
            )}
          </div>
        )}
      </div>

      {composer && (
        <div className="twb-embed-input-bar">
          <ChatInput
            sessionId={sessionId}
            isStreaming={isStreaming}
            hideNewChat
            onSend={handleSend}
            onNewChat={() => {}}
            onStop={() => void cancel(sessionId)}
            onClearContext={() => void clearContext(sessionId)}
            onAdjustContext={() => navigate('/agents')}
          />
        </div>
      )}

      <ChatTimeline sessionId={sessionId} scrollRef={scrollRef} revision={revision} />
    </div>
  )
}

export default EmbeddedChat
