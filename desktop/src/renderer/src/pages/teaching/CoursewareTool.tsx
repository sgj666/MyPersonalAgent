// 课件 — slide rail, a large 16:9 preview and the speaker notes (design §3.2).
// The page outline (deck JSON) is the single source: confirm it, edit any
// page, then render; one page can be redrawn without touching the others.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  FileDown,
  History,
  Images,
  MonitorPlay,
  Presentation,
  RefreshCw,
  Sparkles,
  Square,
  Wand2,
} from 'lucide-react'
import { t, tf } from '../../i18n'
import type { TeachingRecentItem } from '../../api/client'
import EmbeddedChat from '../../components/EmbeddedChat'
import CardPreview from '../../components/teaching/CardPreview'
import DeliverBar, { type DeliverStatus } from '../../components/teaching/DeliverBar'
import { bookChoices, filesUnder, knowledgeFiles, SelectOrType, TEXTBOOKS, UNIT_CHOICES } from '../../components/teaching/MaterialPicker'
import { Skeleton } from '../../components/teaching/states'
import { DEMO_DECK } from '../../components/teaching/demoData'
import { openImage, revealInFolder, saveCardImage } from '../../lib/exportImage'
import { errorText, shortDate } from '../../lib/teaching'
import {
  DECK_LAYOUTS,
  DECK_THEMES,
  extractJson,
  isSvgPage,
  moveItem,
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
/** A deck page's own size: the renderer draws 1280×720 (ppt-master's ppt169
    canvas), so a 1920×1080 frame left two thirds of the box empty. */
const SLIDE_W = 1280
const SLIDE_H = 720
/** Wait this long after the last edit before re-rendering the preview. */
const PREVIEW_DEBOUNCE_MS = 900
const DEFAULT_PAGES = 12
/** The skill writes 10–16 pages and allows ±2; this is the range it accepts. */
const PAGES_MIN = 8
const PAGES_MAX = 18

type SourceMode = 'plan' | 'manual'

/** Layouts whose body is a plain bullet list the side editor can change. */
const BULLET_LAYOUTS: DeckLayout[] = ['agenda', 'objectives', 'bullets', 'summary']

const CoursewareTool: React.FC = () => {
  const source = useTeachingSource()
  const [params] = useSearchParams()
  const sessionId = sessionOf('courseware')
  const skill = useSkillRun(sessionId)
  const handoffPlan = params.get('plan') || ''
  const [mode, setMode] = useState<SourceMode>(handoffPlan || !params.get('unit') ? 'plan' : 'manual')
  const [planPath, setPlanPath] = useState(handoffPlan)
  const [book, setBook] = useState('')
  const [unit, setUnit] = useState(params.get('unit') || '')
  const [theme, setTheme] = useState<DeckTheme>('lecture')
  const [pages, setPages] = useState(DEFAULT_PAGES)
  const [deck, setDeck] = useState<DeckDraft | null>(null)
  const [current, setCurrent] = useState(0)
  const [redrawing, setRedrawing] = useState(false)
  const [status, setStatus] = useState<DeliverStatus>({ text: '' })
  const [busy, setBusy] = useState<string>('')
  const [lastFile, setLastFile] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const previewSeq = useRef(0)

  // ?demo=1 opens on a filled deck: the rail, the preview and the script pane
  // all show real content instead of three placeholders.
  useEffect(() => {
    if (source.demo !== '1') return
    setDeck({ ...DEMO_DECK })
    setStatus({ text: tf('twt_deck_ready', { n: DEMO_DECK.slides.length }), tone: 'ok' })
    // Seed once per demo mount; later edits are the teacher's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.demo])

  const knowledge = useLoad(source.knowledge, EMPTY_KNOWLEDGE, `k${source.demo}`)
  const profile = useLoad(source.profile, {}, `pr${source.demo}`)
  const recentPlans = useLoad(() => source.recent('plan'), [], `p${source.demo}`)
  const records = useLoad(() => source.recent('deck', 20), [] as TeachingRecentItem[], `h${source.demo}`)
  // A template the teacher already keeps (a .pptx master, or a lesson plan as
  // a page-order reference); empty keeps the built-in theme and layout set.
  const [templatePath, setTemplatePath] = useState('')
  const files = useMemo(() => knowledgeFiles(knowledge.data), [knowledge.data])
  const templates = useMemo(
    () =>
      files.filter(
        (entry) =>
          /\.pptx$/i.test(entry.path) || entry.dir === KB.plans || entry.dir.startsWith(`${KB.plans}/`)
      ),
    [files]
  )
  const books = useMemo(
    () => Array.from(new Set([...TEXTBOOKS, ...bookChoices(files, KB.textbook, profile.data.textbook || '')])),
    [files, profile.data]
  )
  // Units of the chosen textbook; without one, every unit under 教材/.
  const units = useMemo(
    () =>
      Array.from(
        new Set([
          ...UNIT_CHOICES,
          ...(book ? filesUnder(files, `${KB.textbook}/${book}`) : []).map((f) => f.title.replace(/\.md$/, '')),
        ])
      ),
    [files, book]
  )

  // The teacher's own textbook fills the empty field once.
  useEffect(() => {
    if (!book && profile.data.textbook) setBook(profile.data.textbook)
  }, [book, profile.data])

  const planChoices = useMemo(() => {
    const kb = filesUnder(files, KB.plans).map((f) => ({ path: `knowledge/${f.path}`, title: f.title }))
    const recent = recentPlans.data.map((r) => ({ path: r.rel, title: r.title }))
    const all = [...(handoffPlan ? [{ path: handoffPlan, title: handoffPlan.split('/').pop() || handoffPlan }] : []), ...recent, ...kb]
    return all.filter((item, i) => all.findIndex((x) => x.path === item.path) === i)
  }, [files, recentPlans.data, handoffPlan])

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

  // Re-render after edits settle, and keep the record on disk in step with
  // what the teacher sees; the rail and notes stay editable meanwhile.
  useEffect(() => {
    if (!deck) return
    const timer = window.setTimeout(() => {
      renderPreview(deck)
      void saveDraft(deck).then(() => records.reload())
    }, PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // renderPreview and saveDraft read only the latest source and deck.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck])

  const slide = deck?.slides[current] || null
  const setSlides = (slides: DeckSlide[]) => {
    setDeck((d) => (d ? { ...d, slides } : d))
    setCurrent((i) => Math.min(i, Math.max(0, slides.length - 1)))
  }
  /** Slides are exported in array order, so moving one here moves its page. */
  const movePage = (by: number) => {
    if (!deck) return
    const to = current + by
    if (to < 0 || to >= deck.slides.length) return
    setSlides(moveItem(deck.slides, current, to))
    setCurrent(to)
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
    const p = { book, unit, plan_path: mode === 'plan' ? planPath : '', theme, pages, template_path: templatePath }
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
      <BarField label={t('tw_f_book')}>
        <SelectOrType
          id="twt-deck-book"
          label={t('tw_f_book')}
          value={book}
          choices={books}
          placeholder={t('twt_book_ph')}
          onChange={setBook}
        />
      </BarField>
      <BarField label={t('tw_f_unit')} grow>
        <SelectOrType
          id="twt-deck-unit"
          label={t('tw_f_unit')}
          value={unit}
          choices={units}
          placeholder={t('twt_unit_pick_ph')}
          onChange={setUnit}
        />
      </BarField>
      <BarField label={t('twt_theme')}>
        <Segs<DeckTheme> label={t('twt_theme')} value={theme} options={DECK_THEMES} onChange={(v) => {
          setTheme(v)
          setDeck((d) => (d ? { ...d, theme: v } : d))
        }} labelOf={(v) => t(`twt_theme_${v}`)} />
      </BarField>
      <BarField label={t('twt_template')}>
        <select
          className="twb-select twt-input"
          value={templatePath}
          onChange={(e) => setTemplatePath(e.target.value)}
        >
          <option value="">{t('twt_template_default')}</option>
          {templates.map((entry) => (
            <option key={entry.path} value={`knowledge/${entry.path}`}>
              {entry.title}
            </option>
          ))}
        </select>
      </BarField>
      <BarField label={t('tw_f_slides')}>
        <input
          className="twb-input twt-input is-num"
          type="number"
          min={PAGES_MIN}
          max={PAGES_MAX}
          value={pages}
          onChange={(e) => setPages(Math.max(PAGES_MIN, Math.min(PAGES_MAX, Number(e.target.value) || DEFAULT_PAGES)))}
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

  /** A chat answer carrying a whole deck replaces the deck; a question or a
      single-page rewrite is just conversation. */
  const acceptReply = (text: string) => {
    const parsed = normalizeDeck(extractJson(text))
    if (!parsed) return
    setDeck(parsed)
    setCurrent((i) => Math.min(i, parsed.slides.length - 1))
    setStatus({ text: tf('twt_deck_ready', { n: parsed.slides.length }), tone: 'ok' })
  }

  /** A saved deck reopens here, with its textbook and unit back in the bar so
      重做课件 reproduces it. */
  const openRecord = async (item: TeachingRecentItem) => {
    try {
      const parsed = normalizeDeck(await source.loadDraft('deck', item.slug))
      if (!parsed) throw new Error(t('twt_parse_failed'))
      setDeck(parsed)
      setCurrent(0)
      if (parsed.meta.book) setBook(parsed.meta.book)
      if (parsed.meta.unit) setUnit(parsed.meta.unit)
      setStatus({ text: tf('twt_deck_loaded', { title: item.title }), tone: 'ok' })
      setShowHistory(false)
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    }
  }

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
      <div className={`twt-deck is-chat${deck ? '' : ' is-empty'}`}>
        {/* The page is a conversation first: the Skill writes the deck, the
            right side shows what it wrote, 重画 changes one page in place. */}
        <aside className="twt-card twt-chat" aria-label={t('twt_chat')}>
          <div className="twt-card-head">
            <h2>{t('twt_chat')}</h2>
            <button
              type="button"
              className="twb-link twt-chat-records"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((value) => !value)}
            >
              <History size={13} />
              <span>{t('twt_deck_history')}</span>
              {records.data.length > 0 && <span className="twt-count">{records.data.length}</span>}
            </button>
          </div>
          {showHistory && (
            <div className="twt-chat-records-panel">
              {records.loading ? (
                <Skeleton lines={3} height={18} />
              ) : records.data.length ? (
                <ul className="twt-hist-list">
                  {records.data.map((item) => (
                    <li key={`${item.slug}-${item.when}`}>
                      <button type="button" className="twt-hist-open" onClick={() => void openRecord(item)}>
                        <History size={13} />
                        <span className="twt-hist-title">{item.title}</span>
                        <span className="twt-hist-when">{shortDate(item.when)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="twt-muted">{t('twt_deck_history_empty')}</p>
              )}
            </div>
          )}
          <EmbeddedChat
            sessionId={sessionId}
            className="twt-chat-embed"
            composer
            placeholder={t('twt_deck_chat_ph')}
            onReply={acceptReply}
          />
        </aside>

        {deck ? (
          <>
            <section className="twt-card twt-stage">
              <div className="twt-card-head">
                <h2>{tf('twt_slide_n', { n: current + 1, total: deck.slides.length })}</h2>
                <div className="twt-head-actions">
                  <span className="twt-page-nav">
                    <button
                      type="button"
                      className="twb-icon-btn"
                      aria-label={t('twt_page_prev')}
                      title={t('twt_page_prev')}
                      disabled={current === 0}
                      onClick={() => setCurrent(current - 1)}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <button
                      type="button"
                      className="twb-icon-btn"
                      aria-label={t('twt_page_next')}
                      title={t('twt_page_next')}
                      disabled={current >= deck.slides.length - 1}
                      onClick={() => setCurrent(current + 1)}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </span>
                  <button type="button" className="twb-link" onClick={() => movePage(-1)} disabled={current === 0}>
                    {t('twt_page_up')}
                  </button>
                  <button
                    type="button"
                    className="twb-link"
                    onClick={() => movePage(1)}
                    disabled={current >= deck.slides.length - 1}
                  >
                    {t('twt_page_down')}
                  </button>
                  {slide && !isSvgPage(slide) && (
                    <label className="twt-inline">
                      <span>{t('twt_change_layout')}</span>
                      <select
                        className="twb-select twt-input is-compact"
                        value={slide.layout}
                        onChange={(e) => patchSlide({ layout: e.target.value as DeckLayout })}
                      >
                        {DECK_LAYOUTS.map((layout) => (
                          <option key={layout} value={layout}>
                            {t(`twt_layout_${layout}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button type="button" className="twb-btn twt-btn-md" onClick={redraw} disabled={skill.running}>
                    {redrawing ? <RefreshCw size={14} className="twb-spin" /> : <Wand2 size={14} />}
                    <span>{t('twt_redraw')}</span>
                  </button>
                </div>
              </div>
              <div className="twt-page-strip" role="tablist" aria-label={t('twt_rail')}>
                {deck.slides.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={i === current}
                    title={s.title || t('twt_untitled')}
                    className={`twt-page-chip${i === current ? ' is-on' : ''}`}
                    onClick={() => setCurrent(i)}
                  >
                    {i + 1}
                  </button>
                ))}
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
              {slide && !isSvgPage(slide) && (
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
              <div className="twt-stage-notes">
                <div className="twt-stage-notes-head">
                  <span className="twt-bar-label">{t('twt_notes')}</span>
                  <span className={`twt-count${notesTone}`}>
                    {tf('twt_notes_count', { n: notesLen, min: NOTES_MIN, max: NOTES_MAX })}
                  </span>
                </div>
                <textarea
                  className="twb-textarea twt-notes-text"
                  value={slide?.notes || ''}
                  aria-label={t('twt_notes')}
                  placeholder={t('twt_notes_ph')}
                  onChange={(e) => patchSlide({ notes: e.target.value })}
                />
                <p className="twt-muted">{t('twt_notes_hint')}</p>
              </div>
          </section>
          </>
        ) : skill.running ? (
          <div className="twt-card twt-full twt-chat-span">
            <div className="twt-deck-skel">
              <Skeleton lines={8} height={30} />
              <div className="twt-preview-skel is-wide" />
            </div>
          </div>
        ) : (
          /* A blank page with one button reads as an empty room. This states
             the loop and shows the three shapes a deck is made of. */
          <section className="twt-card twt-first twt-chat-span">
            <div className="twt-first-head">
              <span className="twt-first-badge" aria-hidden="true">
                <Presentation size={22} />
              </span>
              <div>
                <h2>{t('twt_deck_first_title')}</h2>
                <p>{t('twt_deck_first_desc')}</p>
              </div>
            </div>
            <div className="twt-first-body">
              <ol className="twt-first-steps">
                {([1, 2, 3] as const).map((n) => (
                  <li key={n}>
                    <b>{n}</b>
                    <div>
                      <h3>{t(`twt_deck_first_s${n}`)}</h3>
                      <p>{t(`twt_deck_first_s${n}_desc`)}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {/* Three slide shapes, drawn in CSS: cover / two columns / process. */}
              <figure className="twt-first-mock" aria-label={t('twt_deck_mock_label')}>
                <div className="twt-mock-slide is-cover">
                  <span />
                  <i />
                  <i className="is-short" />
                </div>
                <div className="twt-mock-slide is-cols">
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
                <div className="twt-mock-slide is-steps">
                  <span />
                  <div>
                    <b />
                    <b />
                    <b />
                  </div>
                </div>
                <figcaption>{t('twt_deck_mock_caption')}</figcaption>
              </figure>
            </div>
            <div className="twt-first-actions">
              <button type="button" className="twb-btn twb-btn-primary" onClick={generate} disabled={!unit.trim() && !planPath}>
                <Sparkles size={15} />
                <span>{t('twt_gen_deck')}</span>
              </button>
              <span className="twb-hint">{t('twt_deck_first_hint')}</span>
            </div>
          </section>
        )}
      </div>
    </ToolFrame>
  )
}

export default CoursewareTool
