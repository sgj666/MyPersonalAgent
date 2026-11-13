// 作业卡片 — class pills, one sentence, the evidence, a tiered question list
// and a portrait 1080×1440 preview (design §3.3, decisions §0: image first,
// no group sending). Main path: pick a class → type the sentence and press
// ⌘/Ctrl+Enter → 保存图片.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCopy, ClipboardList, ImageDown, NotebookPen, Printer, Sparkles, Square } from 'lucide-react'
import { t, tf } from '../../i18n'
import apiClient from '../../api/client'
import type { TeachingFact } from '../../api/client'
import CardPreview from '../../components/teaching/CardPreview'
import DeliverBar, { type DeliverStatus } from '../../components/teaching/DeliverBar'
import DraftOutline from '../../components/teaching/DraftOutline'
import FactsStrip from '../../components/teaching/FactsStrip'
import { ClassPicker, filesUnder, knowledgeFiles, UnitPicker, unitChoices } from '../../components/teaching/MaterialPicker'
import { Skeleton, StartHint } from '../../components/teaching/states'
import { DEMO_CARD } from '../../components/teaching/demoData'
import { revealInFolder, saveCardImage, saveCardPdf } from '../../lib/exportImage'
import { errorText, todayISO } from '../../lib/teaching'
import {
  CARD_MAX_ITEMS_PER_SECTION,
  CARD_TIERS,
  extractJson,
  normalizeCard,
  renumberCard,
  slugify,
  type CardDraft,
  type CardItem,
  type CardTier,
} from './drafts'
import { CARD_KINDS, cardPrompt, emptyCard, TIER_HEADINGS, KB } from './prompts'
import { ANSWER_UNSUPPORTED, useTeachingSource, type PreviewResult } from './source'
import { useLoad } from './useLoad'
import { useSkillRun } from './useSkillRun'
import ToolFrame, { BarField, Segs, sessionOf } from './ToolFrame'

const EMPTY_KNOWLEDGE = { tree: [], stats: { pages: 0, size: 0 }, enabled: true }
const CARD_W = 1080
const CARD_H = 1440
const PREVIEW_DEBOUNCE_MS = 900

/** Question rows carry a local key so drag and fold survive edits. */
interface Row extends CardItem {
  key: string
}

type Tiers = Record<CardTier, Row[]>

let rowSeq = 0
const toRow = (item: CardItem): Row => ({ ...item, key: `q${rowSeq++}` })

function tiersOf(card: CardDraft): Tiers {
  const out: Tiers = { basic: [], advanced: [], challenge: [] }
  for (const sec of card.sections) out[sec.tier].push(...sec.items.map(toRow))
  return out
}

/** The tier lists back into contract sections, one per non-empty tier. */
function cardFrom(base: CardDraft, tiers: Tiers): CardDraft {
  const sections = CARD_TIERS.filter((tier) => tiers[tier].length).map((tier) => {
    const old = base.sections.find((s) => s.tier === tier)
    return {
      heading: old?.heading || TIER_HEADINGS[tier],
      tier,
      hint: old?.hint || '',
      items: tiers[tier].map(({ key: _key, ...item }) => item),
    }
  })
  return renumberCard({ ...base, sections })
}

const CardTool: React.FC = () => {
  const source = useTeachingSource()
  const skill = useSkillRun(sessionOf('card'))

  const [classIds, setClassIds] = useState<string[]>([])
  const [kind, setKind] = useState(CARD_KINDS[0])
  const [due, setDue] = useState('')
  const [intent, setIntent] = useState('')
  const [unit, setUnit] = useState('')
  const [factOff, setFactOff] = useState<Set<string>>(new Set())
  const [kpOn, setKpOn] = useState<Set<string>>(new Set())
  const [card, setCard] = useState<CardDraft | null>(null)
  const [tiers, setTiers] = useState<Tiers>({ basic: [], advanced: [], challenge: [] })
  const [answer, setAnswer] = useState(false)
  const [status, setStatus] = useState<DeliverStatus>({ text: '' })
  const [busy, setBusy] = useState('')
  const [lastPng, setLastPng] = useState('')

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const previewSeq = useRef(0)

  const classes = useLoad(source.classes, [], `c${source.demo}`)
  const knowledge = useLoad(source.knowledge, EMPTY_KNOWLEDGE, `k${source.demo}`)

  // One class is the common case; preselect it so the main path skips a click.
  useEffect(() => {
    if (classes.data.length === 1 && !classIds.length) setClassIds([classes.data[0].id])
    // Only when the class list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes.data])

  const factsKey = `${source.demo}|${classIds.join(',')}|${unit}`
  const facts = useLoad(
    async () => {
      const lists = await Promise.all(
        classIds.map(async (id) => {
          const res = await source.facts(id, unit)
          const name = classes.data.find((c) => c.id === id)?.name || id
          return res.facts.map((f) => ({ ...f, key: `${id}:${f.key}`, label: classIds.length > 1 ? `${name} · ${f.label}` : f.label }))
        })
      )
      return lists.flat()
    },
    [] as TeachingFact[],
    factsKey,
    classIds.length > 0
  )

  const files = useMemo(() => knowledgeFiles(knowledge.data), [knowledge.data])
  const units = useMemo(() => unitChoices(files, KB.textbook), [files])
  const points = useMemo(() => {
    const needle = unit.trim().toLowerCase()
    if (!needle) return []
    return filesUnder(files, KB.textbook).filter((f) => f.title.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
  }, [files, unit])

  const evidence = facts.data.filter((f) => !factOff.has(f.key))
  const classNames = classIds.map((id) => classes.data.find((c) => c.id === id)?.name || id)

  const draft = useMemo(() => (card ? cardFrom(card, tiers) : null), [card, tiers])

  const renderPreview = (next: CardDraft, wantAnswer: boolean) => {
    const mine = ++previewSeq.current
    setPreviewLoading(true)
    setPreviewError('')
    source
      .preview('card', next, { answer: wantAnswer })
      .then((result) => {
        if (mine === previewSeq.current) setPreview(result)
      })
      .catch((err: unknown) => {
        if (mine !== previewSeq.current) return
        const msg = errorText(err)
        setPreview(null)
        setPreviewError(msg === ANSWER_UNSUPPORTED ? t('twt_answer_unsupported') : msg)
      })
      .finally(() => {
        if (mine === previewSeq.current) setPreviewLoading(false)
      })
  }

  useEffect(() => {
    if (!draft) return
    const timer = window.setTimeout(() => renderPreview(draft, answer), PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // renderPreview reads only the latest source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, answer])

  const meta = (): Partial<CardDraft['meta']> => ({
    class_name: classNames.join('、'),
    class_ids: classIds,
    unit,
    title: unit ? `${unit} ${kind}` : kind,
    date: todayISO(),
    due,
  })

  const generate = () => {
    if (!classIds.length) {
      setStatus({ text: t('twt_need_class'), tone: 'warn' })
      return
    }
    if (!intent.trim()) {
      setStatus({ text: t('twt_need_intent'), tone: 'warn' })
      return
    }
    setStatus({ text: t('twt_generating_card') })
    const accept = (parsed: CardDraft) => {
      const next = { ...parsed, meta: { ...parsed.meta, ...meta(), title: parsed.meta.title || String(meta().title) } }
      setCard(next)
      setTiers(tiersOf(next))
      setStatus({ text: t('twt_card_ready'), tone: 'ok' })
    }
    if (source.demo) {
      accept(DEMO_CARD)
      return
    }
    const params = {
      class_ids: classIds,
      class_names: classNames,
      kind,
      due,
      intent: intent.trim(),
      unit,
      evidence,
      knowledge_paths: Array.from(kpOn).map((p) => `knowledge/${p}`),
    }
    void skill.run(cardPrompt(params), `${t('twt_card_display')} · ${intent.trim()}`, (reply) => {
      const parsed = normalizeCard(extractJson(reply))
      if (!parsed) {
        setStatus({ text: t('twt_parse_failed'), tone: 'error' })
        return
      }
      accept(parsed)
    })
  }

  const startBlank = () => {
    const blank = emptyCard(meta())
    setCard(blank)
    setTiers({ basic: [toRow({ no: 1, type: 'task', stem: '', duration: 10, answer: '' })], advanced: [], challenge: [] })
  }

  const receive = (to: CardTier) => (fromGroup: string, fromIndex: number, toIndex: number) => {
    const from = fromGroup as CardTier
    if (!CARD_TIERS.includes(from) || from === to) return
    if (tiers[to].length >= CARD_MAX_ITEMS_PER_SECTION) {
      setStatus({ text: tf('twt_tier_full', { n: CARD_MAX_ITEMS_PER_SECTION }), tone: 'warn' })
      return
    }
    setTiers((prev) => {
      const moving = prev[from][fromIndex]
      if (!moving) return prev
      const target = prev[to].slice()
      target.splice(toIndex, 0, moving)
      return { ...prev, [from]: prev[from].filter((_, i) => i !== fromIndex), [to]: target }
    })
  }

  /** The rendered student copy on disk; renders first if the preview is stale. */
  const htmlFile = async (a4: boolean): Promise<string> => {
    if (!draft) throw new Error(t('twt_need_card'))
    const result = await source.render({ kind: 'card', draft, formats: [a4 ? 'a4' : 'html'], a4 })
    const file = result.files.find((f) => f.format === (a4 ? 'a4' : 'html'))
    if (!file) throw new Error(t('twt_render_no_file'))
    return file.path
  }

  const saveDraftQuietly = async () => {
    if (!draft) return
    try {
      await source.saveDraft('card', slugify(`${classNames.join('-')}-${draft.meta.title}`), draft)
    } catch {
      // The draft copy is a convenience; the export result is what is reported.
    }
  }

  const saveImage = async (): Promise<string> => {
    const htmlPath = await htmlFile(false)
    const res = await saveCardImage(htmlPath, { width: CARD_W, height: CARD_H })
    if (!res.ok) throw new Error(res.error)
    setLastPng(res.path)
    return res.path
  }

  const run = (key: string, task: () => Promise<string>) => async () => {
    setBusy(key)
    try {
      await saveDraftQuietly()
      setStatus({ text: await task(), tone: 'ok' })
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    } finally {
      setBusy('')
    }
  }

  const doSaveImage = run('png', async () => `${t('twt_saved_to')} ${await saveImage()}`)
  const doCopy = run('copy', async () => {
    const path = lastPng || (await saveImage())
    const ok = await copyImage(apiClient.getServeFileUrl(path))
    if (!ok) throw new Error(t('twt_copy_failed'))
    return t('twt_copied')
  })
  const doPrint = run('pdf', async () => {
    const res = await saveCardPdf(await htmlFile(true))
    if (!res.ok) throw new Error(res.error)
    return `${t('twt_saved_to')} ${res.path}`
  })
  const doRecord = run('record', async () => {
    if (!draft) throw new Error(t('twt_need_card'))
    await source.createHomework({ class_ids: classIds, title: draft.meta.title, kind: 'practice', due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined })
    return t('twt_recorded')
  })

  const shownStatus: DeliverStatus = skill.error
    ? { text: skill.error, tone: 'error' }
    : skill.running
      ? { text: t('twt_running') }
      : status

  const bar = (
    <>
      <BarField label={t('twt_classes')} grow>
        <ClassPicker
          classes={classes.data}
          value={classIds}
          onChange={setClassIds}
          loading={classes.loading}
          error={classes.error}
          onRetry={classes.reload}
        />
      </BarField>
      <BarField label={t('twt_card_kind')}>
        <Segs label={t('twt_card_kind')} value={kind} options={CARD_KINDS} onChange={setKind} labelOf={(v) => t(`twt_card_kind_${CARD_KINDS.indexOf(v)}`)} />
      </BarField>
      <BarField label={t('twt_due')}>
        <input className="twb-input twt-input is-date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </BarField>
    </>
  )

  const noCard = !draft
  const actions = [
    { key: 'png', label: t('twt_save_image'), icon: ImageDown, onClick: () => void doSaveImage(), primary: true, disabled: noCard, busy: busy === 'png' },
    { key: 'copy', label: t('twt_copy_image'), icon: ClipboardCopy, onClick: () => void doCopy(), disabled: noCard, busy: busy === 'copy' },
    { key: 'pdf', label: t('twt_print_a4'), icon: Printer, onClick: () => void doPrint(), disabled: noCard, busy: busy === 'pdf' },
    { key: 'record', label: t('twt_save_record'), icon: NotebookPen, onClick: () => void doRecord(), disabled: noCard || !classIds.length, busy: busy === 'record' },
  ]

  const itemRow = (tier: CardTier) => (
    <DraftOutline<Row>
      key={tier}
      label={t(`twt_tier_${tier}`)}
      group={tier}
      items={tiers[tier]}
      keyOf={(r) => r.key}
      onChange={(rows) => setTiers((prev) => ({ ...prev, [tier]: rows }))}
      onReceive={receive(tier)}
      numbered={false}
      emptyText={t('twt_tier_drop')}
      onAdd={
        tiers[tier].length < CARD_MAX_ITEMS_PER_SECTION
          ? () => setTiers((prev) => ({ ...prev, [tier]: [...prev[tier], toRow({ no: 0, type: 'task', stem: '', duration: 10, answer: '' })] }))
          : undefined
      }
      addLabel={t('twt_add_item')}
      renderRow={(row) => (
        <span className="twt-q-line">
          <span className="twt-q-stem">{row.stem || t('twt_untitled')}</span>
          {row.duration ? <span className="twt-q-min">{tf('twt_minutes', { n: row.duration })}</span> : null}
        </span>
      )}
      renderDetail={(row, _i, update) => (
        <div className="twt-q-edit">
          <textarea className="twb-textarea" rows={2} value={row.stem} placeholder={t('twt_task_ph')} onChange={(e) => update({ ...row, stem: e.target.value })} />
          <div className="twt-q-edit-row">
            <input
              className="twb-input twt-input"
              value={row.requirement || ''}
              placeholder={t('twt_requirement_ph')}
              onChange={(e) => update({ ...row, requirement: e.target.value })}
            />
            <label className="twt-inline">
              <span>{t('twt_duration')}</span>
              <input
                className="twb-input twt-input is-num"
                type="number"
                min={1}
                max={180}
                value={row.duration ?? 10}
                onChange={(e) => update({ ...row, duration: Number(e.target.value) || 1 })}
              />
            </label>
          </div>
          <input className="twb-input twt-input" value={row.answer} placeholder={t('twt_answer_ph')} onChange={(e) => update({ ...row, answer: e.target.value })} />
        </div>
      )}
    />
  )

  return (
    <ToolFrame tool="card" demo={Boolean(source.demo)} bar={bar} deliver={
        <DeliverBar
          status={shownStatus}
          actions={actions}
          extra={
            lastPng ? (
              <button type="button" className="twb-link" onClick={() => void revealInFolder(lastPng)}>
                {t('twt_reveal')}
              </button>
            ) : null
          }
        />
      }
    >
      <div className="twt-card-page">
        <div className="twt-card-left">
          <section className="twt-card twt-intent">
            <div className="twt-intent-row">
              <textarea
                className="twt-intent-input"
                rows={2}
                value={intent}
                placeholder={t('twt_intent_ph')}
                aria-label={t('twt_intent')}
                onChange={(e) => setIntent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    generate()
                  }
                }}
              />
              <button type="button" className="twb-btn twb-btn-primary twt-intent-go" onClick={skill.running ? skill.cancel : generate}>
                {skill.running ? <Square size={14} /> : <Sparkles size={14} />}
                <span>{skill.running ? t('tw_teach_stop') : card ? t('twt_regen_card') : t('twt_gen_card')}</span>
              </button>
            </div>
            <p className="twt-muted">{t('twt_intent_hint')}</p>

            <div className="twt-evidence">
              <div className="twt-evidence-head">
                <h3>{t('twt_evidence')}</h3>
                <div className="twt-evidence-unit">
                  <UnitPicker id="twt-card" value={unit} onChange={setUnit} choices={units} />
                </div>
              </div>
              {classIds.length ? (
                <FactsStrip
                  facts={facts.data}
                  loading={facts.loading}
                  error={facts.error}
                  onRetry={facts.reload}
                  selected={new Set(evidence.map((f) => f.key))}
                  onToggle={(key) =>
                    setFactOff((prev) => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                />
              ) : (
                <p className="twt-muted">{t('twt_evidence_need_class')}</p>
              )}
              {points.length > 0 && (
                <div className="twt-points">
                  {points.map((p) => {
                    const on = kpOn.has(p.path)
                    return (
                      <button
                        key={p.path}
                        type="button"
                        className={`twt-pill is-small${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        title={p.path}
                        onClick={() =>
                          setKpOn((prev) => {
                            const next = new Set(prev)
                            if (next.has(p.path)) next.delete(p.path)
                            else next.add(p.path)
                            return next
                          })
                        }
                      >
                        {p.title}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="twt-card twt-questions">
            <div className="twt-card-head">
              <h2>{t('twt_questions')}</h2>
              {draft && <span className="twt-count">{tf('twt_items_n', { n: draft.sections.reduce((n, s) => n + s.items.length, 0) })}</span>}
            </div>
            {skill.running && !card ? (
              <Skeleton lines={6} height={22} />
            ) : card ? (
              <>
                {CARD_TIERS.map((tier) => (
                  <div key={tier} className={`twt-tier is-${tier}`}>
                    <h3 className="twt-tier-head">
                      <span className={`twt-tier-chip is-${tier}`}>{t(`twt_tier_${tier}`)}</span>
                      <span className="twt-count">{tiers[tier].length}</span>
                    </h3>
                    {itemRow(tier)}
                  </div>
                ))}
                <label className="twt-summary">
                  <span>{t('twt_parent_line')}</span>
                  <input className="twb-input twt-input" value={card.summary} onChange={(e) => setCard({ ...card, summary: e.target.value })} />
                </label>
              </>
            ) : (
              <StartHint icon={ClipboardList} text={t('twt_card_start')} actionLabel={t('twt_start_blank')} onAction={startBlank} />
            )}
          </section>
        </div>

        <aside className="twt-card twt-phone">
          <div className="twt-card-head">
            <h2>{t('twt_card_preview')}</h2>
            <Segs<'student' | 'answer'>
              label={t('twt_card_preview')}
              value={answer ? 'answer' : 'student'}
              options={['student', 'answer']}
              onChange={(v) => setAnswer(v === 'answer')}
              labelOf={(v) => t(`twt_copy_${v}`)}
            />
          </div>
          <div className="twt-phone-shell">
            <CardPreview
              label={t('twt_card_preview')}
              html={preview?.html || null}
              width={CARD_W}
              height={CARD_H}
              loading={previewLoading && !preview}
              error={previewError}
              onRetry={() => draft && renderPreview(draft, answer)}
              emptyText={t('twt_card_preview_empty')}
            />
          </div>
        </aside>
      </div>
    </ToolFrame>
  )
}

/**
 * Put a PNG on the clipboard: fetched through the backend's file endpoint and
 * written as an image ClipboardItem. False when the platform refuses.
 */
async function copyImage(url: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
    const res = await fetch(url)
    if (!res.ok) return false
    const blob = await res.blob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}

export default CardTool
