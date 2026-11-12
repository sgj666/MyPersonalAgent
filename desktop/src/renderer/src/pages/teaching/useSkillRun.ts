// One Skill request on a tool page's own conversation. The page sends a
// structured prompt into `teach-<tool>` (so the exchange is saved under 对话
// like before) and gets the reply text back once the stream ends, to parse
// into its draft.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../store/chatStore'
import type { ChatMessage } from '../../types'
import { errorText } from '../../lib/teaching'

/** The text of a finished assistant turn: `content`, else its content steps. */
function replyText(message: ChatMessage): string {
  if (message.content) return message.content
  return (message.steps || [])
    .filter((step) => step.type === 'content' && step.content)
    .map((step) => step.content)
    .join('\n')
}

export interface SkillRun {
  run: (prompt: string, display: string, onReply: (text: string) => void) => Promise<void>
  cancel: () => void
  running: boolean
  error: string
  clearError: () => void
}

export function useSkillRun(sessionId: string): SkillRun {
  const send = useChatStore((s) => s.send)
  const cancelStream = useChatStore((s) => s.cancel)
  const running = useChatStore((s) => s.sessions[sessionId]?.isStreaming ?? false)
  const pending = useRef<((text: string) => void) | null>(null)
  const [error, setError] = useState('')

  /** Hand the newest assistant reply to the waiting caller, once. */
  const settle = useCallback(() => {
    const onReply = pending.current
    if (!onReply || useChatStore.getState().sessions[sessionId]?.isStreaming) return
    pending.current = null
    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    if (!last) return
    if (last.error) {
      setError(last.error)
      return
    }
    onReply(replyText(last))
  }, [sessionId])

  useEffect(() => {
    if (!running) settle()
  }, [running, settle])

  const run = useCallback(
    async (prompt: string, display: string, onReply: (text: string) => void) => {
      // A double click can land before the stream state rerenders.
      if (useChatStore.getState().sessions[sessionId]?.isStreaming) return
      setError('')
      pending.current = onReply
      try {
        await send(sessionId, prompt, [], display)
        settle()
      } catch (err) {
        pending.current = null
        setError(errorText(err))
      }
    },
    [send, sessionId, settle]
  )

  const cancel = useCallback(() => {
    pending.current = null
    void cancelStream(sessionId)
  }, [cancelStream, sessionId])

  return { run, cancel, running, error, clearError: () => setError('') }
}
