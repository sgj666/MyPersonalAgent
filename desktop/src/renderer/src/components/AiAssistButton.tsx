// The 教学 pages' corner assistant: a right-hand drawer that runs one prompt
// through the Agent on the page it was opened from.
//
// The drawer owns its prompt policy — read the page's teaching tool first,
// write only when the request needs it, and close with one line saying what
// changed — so every page gets the same contract and only supplies its scene,
// its three starting prompts and the teaching tool to read.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Loader2, Sparkles, X } from 'lucide-react'
import { t, tf } from '../i18n'
import { AgentRunError, runAgentPrompt, toolSessionId } from '../lib/agentRun'
import { errorText } from '../lib/teaching'
import { copyToClipboard } from '../pages/teachingShared'
import Markdown from './Markdown'

export interface AiAssistButtonProps {
  /** Teaching tool the Agent must read first, e.g. `class_list`. */
  dataTool: string
  /** One line saying what this page's assistant is for. */
  scene: string
  /** Three prompts the teacher can start from; the first is focused by default. */
  examples: [string, string, string]
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

const AiAssistButton: React.FC<AiAssistButtonProps> = ({ dataTool, scene, examples }) => {
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState('')
  const [result, setResult] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const close = useCallback(() => {
    stop()
    setOpen(false)
  }, [stop])

  // Escape closes the drawer, the same as the clay dialogs.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // While text streams in, keep the newest lines in view.
  useEffect(() => {
    if (!running) return
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [result, running])

  const run = async () => {
    const text = request.trim()
    if (!text || running) return
    setRunning(true)
    setResult('')
    setError('')
    setStatus('')
    setCopied(false)
    const controller = new AbortController()
    abortRef.current = controller
    let acc = ''
    try {
      const answer = await runAgentPrompt({
        prompt: buildPrompt(dataTool, text),
        sessionId: toolSessionId(`ai-${dataTool}`),
        signal: controller.signal,
        onDelta: (chunk) => {
          acc += chunk
          setResult(acc)
        },
        onStatus: setStatus,
      })
      if (!acc && answer) setResult(answer)
      setStatus('')
    } catch (err) {
      if (err instanceof AgentRunError && err.message === '已取消') {
        setStatus(t('ai_cancelled'))
      } else {
        setError(errorText(err))
        setStatus('')
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const copy = async () => {
    if (!result.trim()) return
    if (await copyToClipboard(result)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <>
      <button
        type="button"
        className="twb-btn twb-ai-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Sparkles size={15} />
        <span>{t('ai_assistant')}</span>
      </button>

      {open && (
        <div className="twb-ai-layer">
          <div className="twb-ai-scrim" onClick={close} />
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
                onClick={close}
              >
                <X size={15} />
              </button>
            </header>

            <div className="twb-ai-body" ref={bodyRef}>
              <div className="twb-ai-examples">
                <span className="twb-hint">{t('ai_examples')}</span>
                {examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="twb-ai-example"
                    onClick={() => setRequest(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>

              <label className="twb-field">
                <span>{t('ai_input_label')}</span>
                <textarea
                  className="twb-textarea"
                  rows={5}
                  value={request}
                  placeholder={t('ai_input_ph')}
                  onChange={(e) => setRequest(e.target.value)}
                />
              </label>

              {status && <p className="twb-hint twb-ai-status">{status}</p>}

              <section className="twb-ai-result" aria-live="polite">
                {error ? (
                  <p className="twb-status is-error">{tf('ai_failed', { msg: error })}</p>
                ) : result ? (
                  <div className="twb-ai-text">
                    <Markdown content={result} />
                    {running && <span className="twb-cursor" aria-hidden />}
                  </div>
                ) : running ? (
                  <div className="twb-ai-skel" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </div>
                ) : (
                  <p className="twb-hint">{t('ai_empty')}</p>
                )}
              </section>
            </div>

            <footer className="twb-ai-foot">
              {running ? (
                <button type="button" className="twb-btn" onClick={stop}>
                  <Loader2 size={15} className="twb-spin" />
                  <span>{t('ai_stop')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="twb-btn twb-btn-primary"
                  disabled={!request.trim()}
                  onClick={() => void run()}
                >
                  <Sparkles size={15} />
                  <span>{t('ai_generate')}</span>
                </button>
              )}
              <button type="button" className="twb-btn" disabled={!result.trim()} onClick={() => void copy()}>
                <Copy size={15} />
                <span>{copied ? t('ai_copied') : t('ai_copy')}</span>
              </button>
              <button type="button" className="twb-btn" onClick={close}>
                <X size={15} />
                <span>{t('ai_close')}</span>
              </button>
            </footer>
          </aside>
        </div>
      )}
    </>
  )
}

export default AiAssistButton
