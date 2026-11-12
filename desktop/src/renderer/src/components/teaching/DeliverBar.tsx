// The bar pinned to the bottom of every tool page: where the draft leaves the
// page. Status on the left, verbs on the right (§7.4: 保存图片 / 导出 pptx /
// 写入进度, never 确定).
import React from 'react'
import { Loader2, type LucideIcon } from 'lucide-react'

export interface DeliverAction {
  key: string
  label: string
  icon?: LucideIcon
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  busy?: boolean
  title?: string
}

export interface DeliverStatus {
  text: string
  tone?: 'plain' | 'ok' | 'warn' | 'error'
}

const DeliverBar: React.FC<{ status?: DeliverStatus; actions: DeliverAction[]; extra?: React.ReactNode }> = ({
  status,
  actions,
  extra,
}) => (
  <footer className="twt-deliver">
    <div className="twt-deliver-status" role="status" aria-live="polite">
      {status?.text && <span className={`twt-dot is-${status.tone || 'plain'}`} aria-hidden="true" />}
      <span className={`twt-deliver-text is-${status?.tone || 'plain'}`}>{status?.text || ''}</span>
      {extra}
    </div>
    <div className="twt-deliver-actions">
      {actions.map(({ key, label, icon: Icon, onClick, primary, disabled, busy, title }) => (
        <button
          key={key}
          type="button"
          className={`twb-btn twt-deliver-btn${primary ? ' twb-btn-primary' : ''}`}
          onClick={onClick}
          disabled={disabled || busy}
          title={title}
        >
          {busy ? <Loader2 size={15} className="twb-spin" /> : Icon ? <Icon size={15} /> : null}
          <span>{label}</span>
        </button>
      ))}
    </div>
  </footer>
)

export default DeliverBar
