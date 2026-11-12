// The computed facts as pills (§4.3): label + number, a click opens the
// detail. On the card page each pill also carries a checkbox, so the teacher
// can drop a fact from the evidence the Skill gets.
import React, { useEffect, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { TeachingFact } from '../../api/client'
import { t } from '../../i18n'
import { InlineError, Skeleton } from './states'

export interface FactsStripProps {
  facts: TeachingFact[]
  loading?: boolean
  error?: string
  onRetry?: () => void
  /** Present → pills are selectable; keyed by `TeachingFact.key` (+ prefix). */
  selected?: Set<string>
  onToggle?: (key: string) => void
  /** Stable id per fact when several classes share one strip. */
  idOf?: (fact: TeachingFact) => string
  emptyText?: string
}

const FactsStrip: React.FC<FactsStripProps> = ({
  facts,
  loading,
  error,
  onRetry,
  selected,
  onToggle,
  idOf = (fact) => fact.key,
  emptyText,
}) => {
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (loading) return <Skeleton lines={1} height={34} className="twt-facts-skel" />
  if (error) return <InlineError message={error} onRetry={onRetry} />
  if (!facts.length) return <p className="twt-muted">{emptyText || t('twt_facts_empty')}</p>

  const openFact = facts.find((fact) => idOf(fact) === open)

  return (
    <div className="twt-facts">
      <div className="twt-facts-row">
        {facts.map((fact) => {
          const id = idOf(fact)
          const isOn = selected ? selected.has(id) : false
          return (
            <span key={id} className={`twt-fact${isOn ? ' is-on' : ''}${open === id ? ' is-open' : ''}`}>
              {selected && onToggle && (
                <button
                  type="button"
                  className="twt-fact-check"
                  role="checkbox"
                  aria-checked={isOn}
                  aria-label={fact.label}
                  onClick={() => onToggle(id)}
                >
                  {isOn && <Check size={11} strokeWidth={3} />}
                </button>
              )}
              <button
                type="button"
                className="twt-fact-body"
                aria-expanded={open === id}
                onClick={() => setOpen(open === id ? null : id)}
              >
                <span className="twt-fact-label">{fact.label}</span>
                <strong className="twt-fact-value">{fact.value}</strong>
                {fact.detail && <ChevronDown size={12} className="twt-fact-caret" />}
              </button>
            </span>
          )
        })}
      </div>
      {openFact?.detail && (
        <p className="twt-fact-detail">
          <strong>{openFact.label}</strong>
          <span>{openFact.detail}</span>
        </p>
      )}
    </div>
  )
}

export default FactsStrip
