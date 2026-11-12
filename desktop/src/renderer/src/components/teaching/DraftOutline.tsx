// The editable list behind every intermediate draft: the lesson outline, the
// slide rail, the question list and the week table (§7.2: add, delete,
// reorder, fold). Rows reorder by drag or by the ↑/↓ buttons (keyboard
// path); lists sharing a `group` family accept rows dragged across.
import React, { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react'
import { t } from '../../i18n'
import { moveItem } from '../../pages/teaching/drafts'

/** The row being dragged; module-level because dragover can't read dataTransfer. */
let dragging: { group: string; index: number } | null = null

export interface DraftOutlineProps<T> {
  items: T[]
  keyOf: (item: T) => string
  onChange: (items: T[]) => void
  /** The always-visible part of a row. */
  renderRow: (item: T, index: number, update: (next: T) => void) => React.ReactNode
  /** The foldable part; rows without it have no fold toggle. */
  renderDetail?: (item: T, index: number, update: (next: T) => void) => React.ReactNode
  selected?: number
  onSelect?: (index: number) => void
  onAdd?: () => void
  addLabel?: string
  /** Lists with the same group id swap rows with each other. */
  group?: string
  /** A row dropped here from another list of the family. */
  onReceive?: (fromGroup: string, fromIndex: number, toIndex: number) => void
  numbered?: boolean
  emptyText?: string
  className?: string
  /** Accessible name of the list. */
  label: string
}

function DraftOutline<T>({
  items,
  keyOf,
  onChange,
  renderRow,
  renderDetail,
  selected,
  onSelect,
  onAdd,
  addLabel,
  group = 'default',
  onReceive,
  numbered = true,
  emptyText,
  className,
  label,
}: DraftOutlineProps<T>): React.ReactElement {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [over, setOver] = useState<number | null>(null)
  // Only the grip starts a drag, so selecting text inside a row's inputs
  // never picks the whole row up.
  const [armed, setArmed] = useState<string | null>(null)

  const update = (index: number) => (next: T) => onChange(items.map((item, i) => (i === index ? next : item)))
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return
    onChange(moveItem(items, from, to))
    if (selected === from) onSelect?.(to)
  }
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const drop = (toIndex: number) => {
    const from = dragging
    dragging = null
    setOver(null)
    if (!from) return
    if (from.group === group) {
      if (from.index !== toIndex) move(from.index, Math.min(toIndex, items.length - 1))
    } else {
      onReceive?.(from.group, from.index, toIndex)
    }
  }

  return (
    <div
      className={`twt-outline${className ? ` ${className}` : ''}`}
      onDragOver={(e) => {
        if (dragging) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        drop(items.length)
      }}
    >
      {items.length === 0 && emptyText && <p className="twt-outline-empty">{emptyText}</p>}
      <ol className="twt-outline-list" aria-label={label}>
        {items.map((item, index) => {
          const key = keyOf(item)
          const isOpen = open.has(key)
          const isSelected = selected === index
          return (
            <li
              key={key}
              className={`twt-row${isSelected ? ' is-selected' : ''}${over === index ? ' is-over' : ''}`}
              draggable={armed === key}
              onDragStart={(e) => {
                dragging = { group, index }
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', key)
              }}
              onDragEnd={() => {
                dragging = null
                setOver(null)
                setArmed(null)
              }}
              onDragOver={(e) => {
                if (!dragging) return
                e.preventDefault()
                setOver(index)
              }}
              onDragLeave={() => setOver((cur) => (cur === index ? null : cur))}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                drop(index)
              }}
            >
              <div className="twt-row-main" onClick={onSelect ? () => onSelect(index) : undefined}>
                <span
                  className="twt-row-grip"
                  aria-hidden="true"
                  onMouseDown={() => setArmed(key)}
                  onMouseUp={() => setArmed(null)}
                >
                  <GripVertical size={14} />
                </span>
                {numbered && <span className="twt-row-no">{index + 1}</span>}
                {renderDetail && (
                  <button
                    type="button"
                    className="twt-row-fold"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? t('twt_fold') : t('twt_unfold')}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(key)
                    }}
                  >
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                )}
                <div className="twt-row-body">{renderRow(item, index, update(index))}</div>
                <span className="twt-row-tools">
                  <button
                    type="button"
                    className="twt-mini-btn"
                    aria-label={t('twt_move_up')}
                    disabled={index === 0}
                    onClick={(e) => {
                      e.stopPropagation()
                      move(index, index - 1)
                    }}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="twt-mini-btn"
                    aria-label={t('twt_move_down')}
                    disabled={index === items.length - 1}
                    onClick={(e) => {
                      e.stopPropagation()
                      move(index, index + 1)
                    }}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    className="twt-mini-btn is-danger"
                    aria-label={t('twt_delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(index)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
              {renderDetail && isOpen && (
                <div className="twt-row-detail">{renderDetail(item, index, update(index))}</div>
              )}
            </li>
          )
        })}
      </ol>
      {onAdd && (
        <button type="button" className="twt-add" onClick={onAdd}>
          <Plus size={13} />
          <span>{addLabel || t('twt_add')}</span>
        </button>
      )}
    </div>
  )
}

export default DraftOutline
