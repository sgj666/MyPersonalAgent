// The frame each tool page fills: a compact head, its own 选料条, the body
// laid out for that tool's output, and the delivery bar pinned at the bottom.
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Copy, ExternalLink, FileText, Lightbulb, Presentation, type LucideIcon } from 'lucide-react'
import { t } from '../../i18n'
import { useSessionStore } from '../../store/sessionStore'
import type { ToolId } from './drafts'

export const TOOL_ICONS: Record<ToolId, LucideIcon> = {
  plan: FileText,
  courseware: Presentation,
  card: Copy,
  advice: Lightbulb,
  schedule: CalendarDays,
}

export const sessionOf = (tool: ToolId): string => `teach-${tool}`

const ToolFrame: React.FC<{
  tool: ToolId
  demo: boolean
  bar: React.ReactNode
  deliver: React.ReactNode
  children: React.ReactNode
}> = ({ tool, demo, bar, deliver, children }) => {
  const navigate = useNavigate()
  const Icon = TOOL_ICONS[tool]
  const sessionId = sessionOf(tool)

  /** The conversation the Skill answered in, opened where it lives in full. */
  const openSession = async () => {
    await useSessionStore.getState().setActive(sessionId)
    // An open editor can refuse the switch; stay rather than land elsewhere.
    if (useSessionStore.getState().activeId === sessionId) navigate('/')
  }

  return (
    <div className={`twt-tool is-${tool}`}>
      <header className="twt-head">
        <span className={`twb-tool-emblem twt-emblem is-${tool}`} aria-hidden="true">
          <Icon size={20} strokeWidth={1.9} />
        </span>
        <div className="twt-head-text">
          <h1>{t(`tw_tool_${tool}`)}</h1>
          <p>{t(`twt_${tool}_lede`)}</p>
        </div>
        {demo && <span className="twt-demo-badge">{t('twt_demo_badge')}</span>}
        <button type="button" className="twb-link twt-head-link" onClick={() => void openSession()}>
          <ExternalLink size={13} />
          <span>{t('twt_open_session')}</span>
        </button>
      </header>
      <div className="twt-bar">{bar}</div>
      <div className="twt-main">{children}</div>
      {deliver}
    </div>
  )
}

export default ToolFrame

/** One labelled control of the 选料条. */
export const BarField: React.FC<{ label: string; children: React.ReactNode; grow?: boolean; htmlFor?: string }> = ({
  label,
  children,
  grow,
  htmlFor,
}) => (
  <div className={`twt-bar-field${grow ? ' is-grow' : ''}`}>
    <label className="twt-bar-label" htmlFor={htmlFor}>
      {label}
    </label>
    {children}
  </div>
)

/** A small segmented choice (theme, kind, focus). */
export function Segs<T extends string>({
  value,
  options,
  onChange,
  labelOf,
  label,
}: {
  value: T
  options: readonly T[]
  onChange: (value: T) => void
  labelOf: (value: T) => string
  label: string
}): React.ReactElement {
  return (
    <div className="twt-segs" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={`twt-seg${value === option ? ' is-on' : ''}`}
          onClick={() => onChange(option)}
        >
          {labelOf(option)}
        </button>
      ))}
    </div>
  )
}
