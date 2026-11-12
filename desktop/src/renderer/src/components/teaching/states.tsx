// Loading / error / empty blocks sized for one region of a tool page (a rail,
// a preview, a list), not the whole page. The page-level versions live in
// pages/teachingShared.tsx.
import React from 'react'
import { RotateCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { t } from '../../i18n'

/** Grey bars in the shape of the content that is coming. */
export const Skeleton: React.FC<{ lines?: number; height?: number; className?: string }> = ({
  lines = 3,
  height = 14,
  className,
}) => (
  <div className={`twt-skel-group${className ? ` ${className}` : ''}`} aria-busy="true" aria-label={t('tw_loading')}>
    {Array.from({ length: lines }, (_, i) => (
      <span key={i} className="twt-skel" style={{ height, width: `${92 - ((i * 17) % 40)}%` }} />
    ))}
  </div>
)

/** A failed call with its reason and a retry; reads as a region, not a page. */
export const InlineError: React.FC<{ message: string; onRetry?: () => void; title?: string }> = ({
  message,
  onRetry,
  title,
}) => (
  <div className="twt-error" role="alert">
    <TriangleAlert size={18} />
    <div>
      <p className="twt-error-title">{title || t('tw_load_failed')}</p>
      {message && <p className="twt-error-msg">{message}</p>}
    </div>
    {onRetry && (
      <button type="button" className="twt-btn-sm" onClick={onRetry}>
        <RotateCw size={13} />
        <span>{t('tw_retry')}</span>
      </button>
    )}
  </div>
)

/** 「怎么开始」: one sentence and one primary button (§7.3). */
export const StartHint: React.FC<{
  icon: LucideIcon
  text: string
  actionLabel?: string
  onAction?: () => void
  disabled?: boolean
}> = ({ icon: Icon, text, actionLabel, onAction, disabled }) => (
  <div className="twt-start">
    <span className="twt-start-ico" aria-hidden="true">
      <Icon size={22} />
    </span>
    <p>{text}</p>
    {actionLabel && onAction && (
      <button type="button" className="twb-btn twb-btn-primary" onClick={onAction} disabled={disabled}>
        {actionLabel}
      </button>
    )}
  </div>
)
