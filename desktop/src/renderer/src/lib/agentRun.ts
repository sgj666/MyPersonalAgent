// Run one prompt through the Agent without leaving the page.
//
// The chat page owns a full timeline store; a tool page only needs the answer
// text as it streams. This wraps the same two calls the timeline makes: POST
// /message, then the /stream EventSource for that request id.
import apiClient from '../api/client'

export interface AgentRunOptions {
  /** What to ask. The caller owns the wording and any skill instruction. */
  prompt: string
  /** Session to keep the exchange under; defaults to a per-tool session. */
  sessionId?: string
  agentId?: string
  /** Called for each streamed answer delta. */
  onDelta?: (text: string) => void
  /** Called with tool names/status lines worth showing while working. */
  onStatus?: (text: string) => void
  signal?: AbortSignal
}

export class AgentRunError extends Error {}

/** A stable session id for a tool, so repeat runs keep one conversation. */
export function toolSessionId(tool: string): string {
  return `tool-${tool}`
}

export async function runAgentPrompt(opts: AgentRunOptions): Promise<string> {
  const sessionId = opts.sessionId || toolSessionId('page-ai')
  const sent = await apiClient.sendMessage(sessionId, opts.prompt, {
    stream: true,
    agentId: opts.agentId,
  })
  if (sent.status !== 'success') {
    throw new AgentRunError(sent.message || '发送失败')
  }
  if (sent.inline_reply) return sent.inline_reply
  const requestId = sent.request_id
  if (!requestId) throw new AgentRunError('没有拿到请求编号')

  // Chromium has withResolvers; the TS lib here predates it, so reach it by shape.
  const { promise, resolve, reject } = (
    Promise as unknown as {
      withResolvers<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
    }
  ).withResolvers<string>()
  {
    let text = ''
    let settled = false
    const es = apiClient.createSSEStream(requestId)
    const finish = (error?: string) => {
      if (settled) return
      settled = true
      es.close()
      if (error) reject(new AgentRunError(error))
      else resolve(text)
    }
    const clean = () => {
      settled = true
      es.close()
    }
    opts.signal?.addEventListener('abort', () => finish('已取消'), { once: true })

    es.onmessage = (event) => {
      let data: { type?: string; content?: string; tool?: string; display?: string }
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      switch (data.type) {
        case 'delta':
          if (data.content) {
            text += data.content
            opts.onDelta?.(data.content)
          }
          break
        case 'tool_start':
          if (data.tool) opts.onStatus?.(`正在使用 ${data.tool}`)
          break
        case 'tool_end':
          if (data.display) opts.onStatus?.(data.display)
          break
        case 'message_end':
          // More may follow (tool calls); 'done' is the real end.
          break
        case 'done':
          finish()
          break
        case 'cancelled':
          finish('已取消')
          break
        case 'error':
          finish(data.content || '生成失败')
          break
        default:
          break
      }
    }
    es.onerror = () => {
      // EventSource reports a close after done as an error too; keep the text
      // only when nothing was streamed, otherwise finish with what we have.
      if (!settled) {
        if (text.trim()) clean()
        else finish('连接中断')
      }
    }
  }
  return promise
}
