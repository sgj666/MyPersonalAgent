// 课件 — slide rail, a large 16:9 preview and the speaker notes (design §3.2).
// The page outline (deck JSON) is the single source: confirm it, edit any
// page, then render; one page can be redrawn without touching the others.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FileDown, Images, MonitorPlay, Presentation, RefreshCw, Sparkles, Square, Wand2 } from 'lucide-react'
import { t, tf } from '../../i18n'
import CardPreview from '../../components/teaching/CardPreview'
import DeliverBar, { type DeliverStatus } from '../../components/teaching/DeliverBar'
import DraftOutline from '../../components/teaching/DraftOutline'
import { filesUnder, knowledgeFiles } from '../../components/teaching/MaterialPicker'
import { Skeleton, StartHint } from '../../components/teaching/states'
import { DEMO_DECK } from '../../components/teaching/demoData'
import { openImage, revealInFolder, saveCardImage } from '../../lib/exportImage'
import { errorText } from '../../lib/teaching'
import {
  DECK_LAYOUTS,
  DECK_THEMES,
  extractJson,
  newId,
  normalizeDeck,
  normalizeSlide,
  NOTES_MAX,
  NOTES_MIN,
  slugify,
  type DeckDraft,
  type DeckLayout,
  type DeckSlide,
  type DeckTheme,
} from './drafts'
import { deckOutlinePrompt, deckRedrawPrompt, KB } from './prompts'
import { useTeachingSource, type PreviewResult } from './source'
import { useLoad } from './useLoad'
import { useSkillRun } from './useSkillRun'
import ToolFrame, { BarField, Segs, sessionOf } from './ToolFrame'

const EMPTY_KNOWLEDGE = { tree: [], stats: { pages: 0, size: 0 }, enabled: true }
const SLIDE_W = 1920
const SLIDE_H = 1080
/** Wait this long after the last edit before re-rendering the preview. */
const PREVIEW_DEBOUNCE_MS = 900
const DEFAULT_PAGES = 12

type SourceMode = 'plan' | 'manual'

/** Layouts whose body is a plain bullet list the side editor can change. */
const BULLET_LAYOUTS: DeckLayout[] = ['agenda', 'objectives', 'bullets', 'summary']

const CoursewareTool: React.FC = () => {
  const source = useTeachingSource()
  const [params] = useSearchParams()
  const skill = useSkillRun(sessionOf('courseware'))

  const handoffPlan = params.get('plan') || ''
  const [mode, setMode] = useState<SourceMode>(handoffPlan || !params.get('unit') ? 'plan' : 'manual')
  const [planPath, setPlanPath] = useState(handoffPlan)
  const [unit, setUnit] = useState(params.get('unit') || '')
  const [theme, setTheme] = useState<DeckTheme>('lecture')
  const [pages, setPages] = useState(DEFAULT_PAGES)
  const [deck, setDeck] = useState<DeckDraft | null>(null)
  const [current, setCurrent] = useState(0)
  const [redrawing, setRedrawing] = useState(false)
  const [status, setStatus] = useState<DeliverStatus>({ text: '' })
  const [busy, setBusy] = useState<string>('')
  const [lastFile, setLastFile] = useState('')

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const previewSeq = useRef(0)

  const knowledge = useLoad(source.knowledge, EMPTY_KNOWLEDGE, `k${source.demo}`)
  const recentPlans = useLoad(() => source.recent('plan'), [], `p${source.demo}`)

  const planChoices = useMemo(() => {
    const kb = filesUnder(knowledgeFiles(knowledge.data), KB.plans).map((f) => ({ path: `knowledge/${f.path}`, title: f.title }))
    const recent = recentPlans.data.map((r) => ({ path: r.rel, title: r.title }))
    const all = [...(handoffPlan ? [{ path: handoffPlan, title: handoffPlan.split('/').pop() || handoffPlan }] : []), ...recent, ...kb]
    return all.filter((item, i) => all.findIndex((x) => x.path === item.path) === i)
  }, [knowledge.data, recentPlans.data, handoffPlan])

  const renderPreview = (draft: DeckDraft) => {
    const mine = ++previewSeq.current
    setPreviewLoading(true)
    setPreviewError('')
    source
      .preview('deck', draft)
      .then((result) => {
        if (mine !== previewSeq.current) return
        setPreview(result)
        if (result.warnings.length) setStatus({ text: result.warnings.join('；'), tone: 'warn' })
      })
      .catch((err: unknown) => {
        if (mine === previewSeq.current) setPreviewError(errorText(err))
      })
      .finally(() => {
        if (mine === previewSeq.current) setPreviewLoading(false)
      })
  }

  // Re-render after edits settle; the rail and notes stay editable meanwhile.
  useEffect(() => {
    if (!deck) return
    const timer = window.setTimeout(() => renderPreview(deck), PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // renderPreview reads only the latest source and deck.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck])

  const slide = deck?.slides[current] || null

  const setSlides = (slides: DeckSlide[]) => {
    setDeck((d) => (d ? { ...d, slides } : d))
    setCurrent((i) => Math.min(i, Math.max(0, slides.length - 1)))
  }
  const patchSlide = (patch: Partial<DeckSlide>) => {
    if (!deck || !slide) return
    setSlides(deck.slides.map((s, i) => (i === current ? { ...s, ...patch } : s)))
  }

  const generate = () => {
    if (!unit.trim() && !planPath) {
      setStatus({ text: t('twt_need_unit'), tone: 'warn' })
      return
    }
    setStatus({ text: t('twt_generating_deck') })
    if (source.demo) {
      setDeck({ ...DEMO_DECK, theme })
      setCurrent(0)
      setStatus({ text: tf('twt_deck_ready', { n: DEMO_DECK.slides.length }), tone: 'ok' })
      return
    }
    const p = { unit, plan_path: mode === 'plan' ? planPath : '', theme, pages }
    void skill.run(deckOutlinePrompt(p), `${t('twt_deck_display')} · ${unit || planPath}`, (reply) => {
      const parsed = normalizeDeck(extractJson(reply))
      if (!parsed) {
        setStatus({ text: t('twt_parse_failed'), tone: 'error' })
        return
      }
      setDeck({ ...parsed, theme })
      setCurrent(0)
      setStatus({ text: tf('twt_deck_ready', { n: parsed.slides.length }), tone: 'ok' })
    })
  }

  const redraw = () => {
    if (!deck || !slide) return
    if (source.demo) {
      setStatus({ text: t('twt_redraw_done'), tone: 'ok' })
      return
    }
    setRedrawing(true)
    const index = current
    void skill
      .run(deckRedrawPrompt(deck, slide, index), tf('twt_redraw_display', { n: index + 1 }), (reply) => {
        const next = normalizeSlide(extractJson(reply))
        if (!next) {
          setStatus({ text: t('twt_parse_failed'), tone: 'error' })
          return
        }
        setDeck((d) => (d ? { ...d, slides: d.slides.map((s, i) => (i === index ? { ...next, id: s.id } : s)) } : d))
        setStatus({ text: t('twt_redraw_done'), tone: 'ok' })
      })
      .finally(() => setRedrawing(false))
  }

  const addSlide = () => {
    if (!deck) return
    const next: DeckSlide = { id: newId('s'), layout: 'bullets', title: t('twt_new_slide'), bullets: [], notes: '' }
    const slides = [...deck.slides.slice(0, current + 1), next, ...deck.slides.slice(current + 1)]
    setDeck({ ...deck, slides })
    setCurrent(current + 1)
  }

  /** Save the source next to the files; a failure is reported, not fatal. */
  const saveDraft = async (draft: DeckDraft): Promise<void> => {
    try {
      await source.saveDraft('deck', slugify(draft.meta.title || unit), draft)
    } catch (err) {
      setStatus({ text: `${t('twt_draft_save_failed')}：${errorText(err)}`, tone: 'warn' })
    }
  }

  const exportPptx = async () => {
    if (!deck) return
    setBusy('pptx')
    try {
      await saveDraft(deck)
      const result = await source.render({ kind: 'deck', draft: deck, formats: ['pptx'] })
      const file = result.files.find((f) => f.format === 'pptx')
      if (!file) throw new Error(t('twt_render_no_file'))
      setLastFile(file.path)
      setStatus({ text: `${t('twt_exported')} ${file.rel}`, tone: result.warnings.length ? 'warn' : 'ok' })
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    } finally {
      setBusy('')
    }
  }

  const exportPngs = async () => {
    if (!deck || !preview?.path) return
    setBusy('png')
    try {
      const htmlPath = preview.path
      for (let n = 1; n <= deck.slides.length; n++) {
        setStatus({ text: tf('twt_png_progress', { n, total: deck.slides.length }) })
        const res = await saveCardImage(htmlPath, {
          width: SLIDE_W,
          height: SLIDE_H,
          selector: `section.slide[data-slide="${n}"]`,
          outPath: htmlPath.replace(/\.html$/, `-${String(n).padStart(2, '0')}.png`),
        })
        if (!res.ok) throw new Error(res.error)
        setLastFile(res.path)
      }
      setStatus({ text: tf('twt_png_done', { n: deck.slides.length }), tone: 'ok' })
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    } finally {
      setBusy('')
    }
  }

  const present = async () => {
    if (!preview?.path) return
    const err = await openImage(preview.path)
    if (err) setStatus({ text: err, tone: 'error' })
  }

  const shownStatus: DeliverStatus = skill.error
    ? { text: skill.error, tone: 'error' }
    : skill.running
      ? { text: t('twt_running') }
      : status

  const noRenderedFile = !preview?.path
  const bar = (
    <>
      <BarField label={t('twt_source')}>
        <Segs<SourceMode>
          label={t('twt_source')}
          value={mode}
          options={['plan', 'manual']}
          onChange={setMode}
          labelOf={(v) => t(`twt_source_${v}`)}
        />
      </BarField>
      {mode === 'plan' && (
        <BarField label={t('twt_plan_file')} grow>
          <select className="twb-select twt-input" value={planPath} onChange={(e) => setPlanPath(e.target.value)}>
            <option value="">{planChoices.length ? t('twt_pick_plan') : t('twt_no_plans')}</option>
            {planChoices.map((item) => (
              <option key={item.path} value={item.path}>
                {item.title}
              </option>
            ))}
          </select>
        </BarField>
      )}
      <BarField label={t('tw_f_unit')} grow={mode === 'manual'}>
        <input className="twb-input twt-input" value={unit} placeholder={t('twt_unit_ph')} onChange={(e) => setUnit(e.target.value)} />
      </BarField>
      <BarField label={t('twt_theme')}>
        <Segs<DeckTheme> label={t('twt_theme')} value={theme} options={DECK_THEMES} onChange={(v) => {
          setTheme(v)
          setDeck((d) => (d ? { ...d, theme: v } : d))
        }} labelOf={(v) => t(`twt_theme_${v}`)} />
      </BarField>
      <BarField label={t('tw_f_slides')}>
        <input
          className="twb-input twt-input is-num"
          type="number"
          min={1}
          max={40}
          value={pages}
          onChange={(e) => setPages(Math.max(1, Math.min(40, Number(e.target.value) || DEFAULT_PAGES)))}
        />
      </BarField>
      <button type="button" className="twb-btn twb-btn-primary twt-bar-go" onClick={skill.running ? skill.cancel : generate}>
        {skill.running ? <Square size={14} /> : <Sparkles size={14} />}
        <span>{skill.running ? t('tw_teach_stop') : deck ? t('twt_regen_deck') : t('twt_gen_deck')}</span>
      </button>
    </>
  )

  const actions = [
    { key: 'pptx', label: t('twt_export_pptx'), icon: FileDown, onClick: () => void exportPptx(), primary: true, disabled: !deck, busy: busy === 'pptx' },
    {
      key: 'png',
      label: t('twt_export_png'),
      icon: Images,
      onClick: () => void exportPngs(),
      disabled: !deck || noRenderedFile,
      busy: busy === 'png',
      title: noRenderedFile ? t('twt_need_preview') : undefined,
    },
    { key: 'show', label: t('twt_present'), icon: MonitorPlay, onClick: () => void present(), disabled: noRenderedFile, title: noRenderedFile ? t('twt_need_preview') : undefined },
  ]

  const notesLen = (slide?.notes || '').length
  const notesTone = notesLen === 0 ? '' : notesLen < NOTES_MIN || notesLen > NOTES_MAX ? ' is-warn' : ' is-ok'

  return (
    <ToolFrame
      tool="courseware"
      demo={Boolean(source.demo)}
      bar={bar}
      deliver={
        <DeliverBar
          status={shownStatus}
          actions={actions}
          extra={
            lastFile ? (
              <button type="button" className="twb-link" onClick={() => void revealInFolder(lastFile)}>
                {t('twt_reveal')}
              </button>
            ) : null
          }
        />
      }
    >
      {!deck ? (
        <div className="twt-card twt-full">
          {skill.running ? (
            <div className="twt-deck-skel">
              <Skeleton lines={8} height={30} />
              <div className="twt-preview-skel is-wide" />
            </div>
          ) : (
            <StartHint icon={Presentation} text={t('twt_deck_start')} actionLabel={t('twt_gen_deck')} onAction={generate} />
          )}
        </div>
      ) : (
        <div className="twt-deck">
          <aside className="twt-card twt-rail" aria-label={t('twt_rail')}>
            <div className="twt-card-head">
              <h2>{t('twt_rail')}</h2>
              <span className="twt-count">{deck.slides.length}</span>
            </div>
            <DraftOutline
              label={t('twt_rail')}
              className="is-rail"
              items={deck.slides}
              keyOf={(s) => s.id}
              onChange={setSlides}
              selected={current}
              onSelect={setCurrent}
              onAdd={addSlide}
              addLabel={t('twt_add_slide')}
              renderRow={(s) => (
                <span className="twt-rail-item">
                  <span className="twt-rail-title">{s.title || t('twt_untitled')}</span>
                  <span className="twt-rail-layout">{t(`twt_layout_${s.layout}`)}</span>
                </span>
              )}
            />
          </aside>

          <section className="twt-card twt-stage">
            <div className="twt-card-head">
              <h2>{tf('twt_slide_n', { n: current + 1, total: deck.slides.length })}</h2>
              <div className="twt-head-actions">
                <label className="twt-inline">
                  <span>{t('twt_change_layout')}</span>
                  <select
                    className="twb-select twt-input is-compact"
                    value={slide?.layout || 'bullets'}
                    onChange={(e) => patchSlide({ layout: e.target.value as DeckLayout })}
                  >
                    {DECK_LAYOUTS.map((layout) => (
                      <option key={layout} value={layout}>
                        {t(`twt_layout_${layout}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="twb-btn twt-btn-md" onClick={redraw} disabled={skill.running}>
                  {redrawing ? <RefreshCw size={14} className="twb-spin" /> : <Wand2 size={14} />}
                  <span>{t('twt_redraw')}</span>
                </button>
              </div>
            </div>
            <CardPreview
              label={t('twt_preview')}
              html={preview?.html || null}
              width={SLIDE_W}
              height={SLIDE_H}
              slide={current + 1}
              loading={previewLoading && !preview}
              error={previewError}
              onRetry={() => deck && renderPreview(deck)}
              emptyText={t('twt_preview_pending')}
            />
            {slide && (
              <div className="twt-slide-edit">
                <input
                  className="twb-input twt-input"
                  value={slide.title}
                  aria-label={t('twt_slide_title')}
                  placeholder={t('twt_slide_title')}
                  onChange={(e) => patchSlide({ title: e.target.value })}
                />
                {BULLET_LAYOUTS.includes(slide.layout) && (
                  <textarea
                    className="twb-textarea"
                    rows={3}
                    aria-label={t('twt_slide_bullets')}
                    placeholder={t('twt_slide_bullets')}
                    value={(slide.bullets || []).join('\n')}
                    onChange={(e) => patchSlide({ bullets: e.target.value.split('\n') })}
                  />
                )}
              </div>
            )}
          </section>

          <aside className="twt-card twt-notes" aria-label={t('twt_notes')}>
            <div className="twt-card-head">
              <h2>{t('twt_notes')}</h2>
              <span className={`twt-count${notesTone}`}>{tf('twt_notes_count', { n: notesLen, min: NOTES_MIN, max: NOTES_MAX })}</span>
            </div>
            <textarea
              className="twb-textarea twt-notes-text"
              value={slide?.notes || ''}
              placeholder={t('twt_notes_ph')}
              onChange={(e) => patchSlide({ notes: e.target.value })}
            />
            <p className="twt-muted">{t('twt_notes_hint')}</p>
          </aside>
        </div>
      )}
    </ToolFrame>
  )
}

export default CoursewareTool
