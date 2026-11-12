// Choosing what a tool works from: classes (pills), a unit (typed or picked
// from knowledge/教材/**), and knowledge files grouped by kind (checkable,
// foldable). Reads come from the page; this file only draws them.
import React, { useState } from 'react'
import { Check, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import type { KnowledgeDir, KnowledgeList, TeachingClass } from '../../types'
import { t, tf } from '../../i18n'
import { InlineError, Skeleton } from './states'

export interface KnowledgeEntry {
  /** Relative to the knowledge root, e.g. `教材/人教新版七上/Unit 3.md`. */
  path: string
  title: string
  /** The directory it sits in, same root. */
  dir: string
}

/** Every file of the knowledge tree, with its full relative path. */
export function knowledgeFiles(list: KnowledgeList): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = []
  for (const file of list.root_files || []) out.push({ path: file.name, title: file.title || file.name, dir: '' })
  const walk = (dir: KnowledgeDir, prefix: string) => {
    const dirPath = prefix ? `${prefix}/${dir.dir}` : dir.dir
    for (const file of dir.files || []) {
      out.push({ path: `${dirPath}/${file.name}`, title: file.title || file.name, dir: dirPath })
    }
    for (const child of dir.children || []) walk(child, dirPath)
  }
  for (const dir of list.tree || []) walk(dir, '')
  return out
}

/** Files whose path starts with one of the given top-level folders. */
export const filesUnder = (files: KnowledgeEntry[], ...roots: string[]): KnowledgeEntry[] =>
  files.filter((file) => roots.some((root) => file.path === root || file.path.startsWith(`${root}/`)))

/** The unit names a textbook folder offers: each file title under 教材/. */
export const unitChoices = (files: KnowledgeEntry[], textbookRoot: string): string[] =>
  Array.from(new Set(filesUnder(files, textbookRoot).map((file) => file.title.replace(/\.md$/, ''))))

// ---------- classes ----------

export const ClassPicker: React.FC<{
  classes: TeachingClass[]
  value: string[]
  onChange: (ids: string[]) => void
  multi?: boolean
  loading?: boolean
  error?: string
  onRetry?: () => void
}> = ({ classes, value, onChange, multi = true, loading, error, onRetry }) => {
  if (loading) return <Skeleton lines={1} height={30} className="twt-pills-skel" />
  if (error) return <InlineError message={error} onRetry={onRetry} />
  if (!classes.length) return <span className="twt-muted">{t('twt_no_classes')}</span>
  const toggle = (id: string) => {
    if (!multi) return onChange([id])
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }
  return (
    <div className="twt-pills" role="group" aria-label={t('twt_classes')}>
      {classes.map((cls) => {
        const on = value.includes(cls.id)
        return (
          <button
            key={cls.id}
            type="button"
            className={`twt-pill${on ? ' is-on' : ''}`}
            aria-pressed={on}
            onClick={() => toggle(cls.id)}
          >
            {on && <Check size={12} strokeWidth={3} />}
            <span>{cls.name}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---------- unit ----------

export const UnitPicker: React.FC<{
  value: string
  onChange: (value: string) => void
  choices: string[]
  id: string
  placeholder?: string
}> = ({ value, onChange, choices, id, placeholder }) => (
  <>
    <input
      className="twb-input twt-input"
      list={`${id}-units`}
      value={value}
      placeholder={placeholder || t('twt_unit_ph')}
      onChange={(e) => onChange(e.target.value)}
    />
    <datalist id={`${id}-units`}>
      {choices.map((choice) => (
        <option key={choice} value={choice} />
      ))}
    </datalist>
  </>
)

// ---------- material groups ----------

export interface MaterialGroup {
  key: string
  label: string
  items: { path: string; title: string; note?: string }[]
}

export const MaterialList: React.FC<{
  groups: MaterialGroup[]
  selected: Set<string>
  onToggle: (path: string) => void
  loading?: boolean
  error?: string
  onRetry?: () => void
}> = ({ groups, selected, onToggle, loading, error, onRetry }) => {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  if (loading) return <Skeleton lines={6} height={16} />
  if (error) return <InlineError message={error} onRetry={onRetry} />
  return (
    <div className="twt-materials">
      {groups.map((group) => {
        const isClosed = closed.has(group.key)
        const picked = group.items.filter((item) => selected.has(item.path)).length
        return (
          <section key={group.key} className="twt-mat-group">
            <button
              type="button"
              className="twt-mat-head"
              aria-expanded={!isClosed}
              onClick={() =>
                setClosed((prev) => {
                  const next = new Set(prev)
                  if (next.has(group.key)) next.delete(group.key)
                  else next.add(group.key)
                  return next
                })
              }
            >
              {isClosed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span>{group.label}</span>
              <span className="twt-count">{tf('twt_picked_of', { n: picked, total: group.items.length })}</span>
            </button>
            {!isClosed &&
              (group.items.length ? (
                <ul className="twt-mat-list">
                  {group.items.map((item) => {
                    const on = selected.has(item.path)
                    return (
                      <li key={item.path}>
                        <label className={`twt-mat-item${on ? ' is-on' : ''}`} title={item.path}>
                          <input type="checkbox" checked={on} onChange={() => onToggle(item.path)} />
                          <FileText size={13} />
                          <span className="twt-mat-title">{item.title}</span>
                          {item.note && <span className="twt-mat-note">{item.note}</span>}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="twt-mat-empty">{t('twt_mat_none')}</p>
              ))}
          </section>
        )
      })}
    </div>
  )
}
