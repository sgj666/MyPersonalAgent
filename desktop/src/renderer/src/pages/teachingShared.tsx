// The chrome the five teaching views share: error / empty / loading blocks,
// the clay dialog, and clipboard copy. Visual styles live in clay.css; the
// academics-only layout rules live in clay-academics.css.
import React, { useEffect, useState } from 'react'
import { Loader2, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { t } from '../i18n'

/** "Could not load, retry" — the same block the home page's panels use. */
export const PageError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="twb-empty">
    <TriangleAlert size={26} />
    <p>{t('tw_load_failed')}</p>
    {message && <p className="twb-hint">{message}</p>}
    <button type="button" className="twb-btn" onClick={onRetry}>
      {t('tw_retry')}
    </button>
  </div>
)

export const Loading: React.FC = () => (
  <p className="twb-loading">
    <Loader2 size={14} className="twb-spin" />
    <span>{t('tw_loading')}</span>
  </p>
)

export const Empty: React.FC<{
  icon: LucideIcon
  text: string
  actionLabel?: string
  onAction?: () => void
}> = ({ icon: Icon, text, actionLabel, onAction }) => (
  <div className="twb-empty">
    <Icon size={26} />
    <p>{text}</p>
    {actionLabel && onAction && (
      <button type="button" className="twb-btn twb-btn-primary" onClick={onAction}>
        {actionLabel}
      </button>
    )}
  </div>
)

/** The clay card dialog. Escape and a click on the scrim close it. */
export const Modal: React.FC<{
  title: string
  onClose: () => void
  children: React.ReactNode
  /** A form's submit button row, rendered at the end of the card. */
  footer?: React.ReactNode
  wide?: boolean
  titleId: string
}> = ({ title, onClose, children, footer, wide, titleId }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="twb-modal">
      <div className="twb-modal-scrim" onClick={onClose} />
      <div
        className={`twb-modal-card${wide ? ' is-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="twb-modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="twb-icon-btn" onClick={onClose} aria-label={t('tw_cancel')}>
            <X size={14} />
          </button>
        </div>
        {children}
        {footer && <div className="twb-modal-actions">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * Clipboard write with a fallback: the renderer can run from a file:// origin
 * where the async clipboard API is not always granted, and a missing 未交名单
 * copy is the one thing this page must not fail silently at.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * One grid cell that commits on blur or Enter. It keeps its own draft so
 * typing does not fight a reload, and only calls back when the value really
 * changed — the roster and progress grids PATCH a single field at a time.
 */
export const EditableCell: React.FC<{
  value: string
  placeholder?: string
  type?: 'text' | 'number'
  className?: string
  /** Return false to reject the edit and put the stored value back. */
  onCommit: (value: string) => void | boolean
}> = ({ value, placeholder, type = 'text', className, onCommit }) => {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className={`twb-grid-input${className ? ` ${className}` : ''}`}
      type={type}
      value={draft}
      placeholder={placeholder}
      min={type === 'number' ? 0 : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim()
        if (next === value) return
        if (onCommit(next) === false) setDraft(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** A toolbar status line: plain, or red for a failed call. */
export const Status: React.FC<{ text: string; error?: boolean }> = ({ text, error }) =>
  text ? (
    <p className={`twb-status${error ? ' is-error' : ''}`} role="status">
      {text}
    </p>
  ) : null
