// 单词听写 — pick a textbook unit (or paste a list), check senses and parts of
// speech, and build a classroom player: one word at a time, standard audio,
// auto dictation, and a summary that saves as images. The HTML comes from the
// backend renderer (agent/teaching/render/dictation_html.py); edits here only
// change the draft it renders.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, ExternalLink, FileDown, History, Printer, Square, Sparkles } from 'lucide-react'
import { t, tf } from '../../i18n'
import type { TeachingRecentItem } from '../../api/client'
import DeliverBar, { type DeliverStatus } from '../../components/teaching/DeliverBar'
import { bookChoices, knowledgeFiles, filesUnder, SelectOrType, TEXTBOOKS, UNIT_CHOICES } from '../../components/teaching/MaterialPicker'
import { Skeleton, StartHint } from '../../components/teaching/states'
import { DEMO_DICTATION } from '../../components/teaching/demoData'
import { openImage, saveCardPdf, revealInFolder } from '../../lib/exportImage'
import { errorText, todayISO } from '../../lib/teaching'
import {
  DICTATION_KINDS,
  extractJson,
  normalizeDictation,
  parseWordList,
  type DictationKind,
  type DictationSense,
  slugify,
  type DictationDraft,
  type DictationMode,
  type DictationWord,
} from './drafts'
import { dictationPrompt, KB } from './prompts'
import { useTeachingSource, type PreviewResult } from './source'
import { useLoad } from './useLoad'
import { useSkillRun } from './useSkillRun'
import ToolFrame, { BarField, Segs, sessionOf } from './ToolFrame'

const EMPTY_KNOWLEDGE = { tree: [], stats: { pages: 0, size: 0 }, enabled: true }
const PREVIEW_DEBOUNCE_MS = 450

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** yyyy-mm-dd hh:mm:ss on the teacher's own clock. */
const stamp = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

const shortDate = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${date.getMonth() + 1}月${date.getDate()}日`
}

const on = (word: DictationWord): boolean => word.on !== false
const filled = (word: DictationWord): boolean => Boolean(word.word.trim())
const selected = (words: DictationWord[]): DictationWord[] => words.filter((word) => on(word) && filled(word))
const POS_CHOICES = ['n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'pron.', 'conj.', 'num.', 'art.', 'int.', 'aux.', 'phr.']

const DictationTool: React.FC = () => {
  const source = useTeachingSource()
  const skill = useSkillRun(sessionOf('dictation'))

  const [book, setBook] = useState('')
  const [unit, setUnit] = useState('')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<DictationKind>('dictation')
  const [mode, setMode] = useState<DictationMode>('zh')
  const [words, setWords] = useState<DictationWord[]>([])
  const [pasting, setPasting] = useState(false)
  const [paste, setPaste] = useState('')
  const [status, setStatus] = useState<DeliverStatus>({ text: '' })
  const [busy, setBusy] = useState('')
  const [lastHtml, setLastHtml] = useState('')

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const previewSeq = useRef(0)

  const knowledge = useLoad(source.knowledge, EMPTY_KNOWLEDGE, `k${source.demo}`)
  const profile = useLoad(source.profile, {}, `pr${source.demo}`)
  const history = useLoad(() => source.recent('dictation', 20), [] as TeachingRecentItem[], `d${source.demo}`)

  const files = useMemo(() => knowledgeFiles(knowledge.data), [knowledge.data])
  const books = useMemo(
    () => Array.from(new Set([...TEXTBOOKS, ...bookChoices(files, KB.textbook, profile.data.textbook || '')])),
    [files, profile.data]
  )
  const units = useMemo(
    () =>
      Array.from(
        new Set([
          ...UNIT_CHOICES,
          ...filesUnder(files, ...(book ? [`${KB.textbook}/${book}`] : [KB.textbook])).map((f) => f.title.replace(/\.md$/, '')),
        ])
      ),
    [files, book]
  )

  // The teacher's own textbook fills the empty field once.
  useEffect(() => {
    if (!book && profile.data.textbook) setBook(profile.data.textbook)
  }, [book, profile.data])

  // ?demo=1 opens on a filled sheet so the page shows what it produces.
  useEffect(() => {
    if (source.demo !== '1') return
    accept(DEMO_DICTATION)
    // Seeding once per demo mount; the teacher's edits must win afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.demo])

  const kindName = kind === 'translation' ? t('twt_dict_kind_translation') : t('twt_dict_kind_dictation')
  const draft = useMemo<DictationDraft | null>(() => {
    // Blank rows are editing placeholders; they never reach the renderer.
    const printable = words.filter(filled)
    return printable.length
      ? {
          version: 1,
          meta: {
            title: title || [book, unit, kindName].filter(Boolean).join(' '),
            book,
            unit,
            date: todayISO(),
            kind,
            mode,
          },
          words: printable,
        }
      : null
  }, [words, title, book, unit, kind, kindName, mode])

  const filledWords = words.filter(filled)
  const chosen = selected(words)
  const allOn = filledWords.length > 0 && chosen.length === filledWords.length

  const renderPreview = (next: DictationDraft) => {
    const mine = ++previewSeq.current
    setPreviewLoading(true)
    setPreviewError('')
    source
      .preview('dictation', next)
      .then((result) => {
        if (mine === previewSeq.current) setPreview(result)
      })
      .catch((err: unknown) => {
        if (mine !== previewSeq.current) return
        setPreview(null)
        setPreviewError(errorText(err))
      })
      .finally(() => {
        if (mine === previewSeq.current) setPreviewLoading(false)
      })
  }

  useEffect(() => {
    if (!draft || !selected(draft.words).length) {
      previewSeq.current++
      setPreview(null)
      setPreviewError('')
      setPreviewLoading(false)
      return
    }
    const timer = window.setTimeout(() => renderPreview(draft), PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // renderPreview reads only the latest source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  /** Take a parsed draft into the page; `allOn` ticks every word (a fresh generation). */
  function accept(parsed: DictationDraft, checkAll = false) {
    setWords(parsed.words.map((word) => ({ ...word, on: checkAll || word.on !== false })))
    setBook(parsed.meta.book || book)
    setUnit(parsed.meta.unit || unit)
    setTitle(parsed.meta.title || '')
    setKind(parsed.meta.kind)
    setMode(parsed.meta.mode)
  }

  const saveDraftQuietly = async (next: DictationDraft) => {
    try {
      await source.saveDraft('dictation', slugify(next.meta.title), next)
      history.reload()
    } catch {
      // History is a convenience; the sheet itself is what the teacher asked for.
    }
  }

  const generate = (nextBook = book, nextUnit = unit, nextKind = kind) => {
    if (!nextBook.trim() || !nextUnit.trim()) {
      setStatus({ text: t('twt_dict_need_book_unit'), tone: 'warn' })
      return
    }
    setStatus({ text: t('twt_dict_generating') })
    // Reading the unit's own textbook page beats the model's memory of it.
    const knowledgePaths = filesUnder(files, `${KB.textbook}/${nextBook.trim()}`)
      .filter((file) => !nextUnit.trim() || file.title.toLowerCase().includes(nextUnit.trim().toLowerCase()))
      .map((file) => `knowledge/${file.path}`)
    void skill.run(
      dictationPrompt({ book: nextBook.trim(), unit: nextUnit.trim(), knowledge_paths: knowledgePaths }),
      `${t('twt_dict_display')} · ${nextBook.trim()} ${nextUnit.trim()}`,
      (reply) => {
        const parsed = normalizeDictation(extractJson(reply))
        if (!parsed) {
          setStatus({ text: t('twt_parse_failed'), tone: 'error' })
          return
        }
        const nextKindName = nextKind === 'translation' ? t('twt_dict_kind_translation') : t('twt_dict_kind_dictation')
        const raw = (parsed.meta.title || `${nextBook.trim()} ${nextUnit.trim()} ${nextKindName}`).trim()
        const base = /单词听写|英译汉/.test(raw) ? raw.replace(/单词听写|英译汉/g, nextKindName) : `${raw} ${nextKindName}`
        const next: DictationDraft = {
          ...parsed,
          meta: {
            ...parsed.meta,
            book: parsed.meta.book || nextBook.trim(),
            unit: parsed.meta.unit || nextUnit.trim(),
            title: `${base} ${stamp()}`,
            date: todayISO(),
            kind: nextKind,
          },
          words: parsed.words.map((word) => ({ ...word, on: true })),
        }
        accept(next, true)
        void saveDraftQuietly(next)
        // Prewarm the standard clips so the first 「在浏览器打开」 is not slow;
        // a failure here is invisible and the open path reports it.
        void source
          .render({ kind: 'dictation', draft: next, formats: ['html'], tts: true, out_name: next.meta.title })
          .catch(() => undefined)
        setStatus({ text: tf('twt_dict_ready', { n: next.words.length }), tone: 'ok' })
      }
    )
  }

  const applyPaste = () => {
    const parsed = parseWordList(paste)
    if (!parsed.length) {
      setStatus({ text: t('twt_dict_paste_empty'), tone: 'warn' })
      return
    }
    ensureTitle()
    setWords(parsed)
    setStatus({ text: tf('twt_dict_paste_ok', { n: parsed.length }), tone: 'ok' })
    setPasting(false)
    setPaste('')
  }

  const setAll = (value: boolean) =>
    setWords((prev) => prev.map((word) => (filled(word) ? { ...word, on: value } : word)))
  const patchWord = (index: number, patch: Partial<DictationWord>) =>
    setWords((prev) => prev.map((word, i) => (i === index ? { ...word, ...patch } : word)))

  const defaultTitle = () => `${[book, unit, kindName].filter(Boolean).join(' ')} ${stamp()}`
  const ensureTitle = () => {
    if (!title.trim()) setTitle(defaultTitle())
  }
  const addWord = () => {
    ensureTitle()
    setWords((prev) => [
      ...prev,
      { word: '', phonetic: '', senses: [{ pos: '', meaning: '' }], on: true },
    ])
  }
  const removeWord = (index: number) => setWords((prev) => prev.filter((_, i) => i !== index))

  const patchSense = (index: number, senseIndex: number, patch: Partial<DictationSense>) =>
    setWords((prev) =>
      prev.map((word, i) =>
        i === index
          ? { ...word, senses: word.senses.map((sense, si) => (si === senseIndex ? { ...sense, ...patch } : sense)) }
          : word
      )
    )
  const addSense = (index: number) =>
    setWords((prev) =>
      prev.map((word, i) => (i === index ? { ...word, senses: [...word.senses, { pos: '', meaning: '' }] } : word))
    )
  const removeSense = (index: number, senseIndex: number) =>
    setWords((prev) =>
      prev.map((word, i) =>
        i === index ? { ...word, senses: word.senses.filter((_, si) => si !== senseIndex) } : word
      )
    )

  const htmlFile = async (): Promise<string> => {
    if (source.demo) throw new Error(t('twt_demo_no_export'))
    if (!draft) throw new Error(t('twt_dict_need_words'))
    const result = await source.render({
      kind: 'dictation',
      draft,
      formats: ['html'],
      tts: true,
      out_name: draft.meta.title,
    })
    const file = result.files.find((f) => f.format === 'html')
    if (!file) throw new Error(t('twt_render_no_file'))
    setLastHtml(file.path)
    return file.path
  }

  const run = (key: string, task: () => Promise<string>) => async () => {
    setBusy(key)
    try {
      if (draft) await saveDraftQuietly(draft)
      setStatus({ text: await task(), tone: 'ok' })
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    } finally {
      setBusy('')
    }
  }

  const doSaveHtml = run('html', async () => `${t('twt_saved_to')} ${await htmlFile()}`)
  const doOpen = run('open', async () => {
    const path = await htmlFile()
    const message = await openImage(path)
    if (message) throw new Error(message)
    return t('twt_dict_opened')
  })
  const doPdf = run('pdf', async () => {
    const res = await saveCardPdf(await htmlFile())
    if (!res.ok) throw new Error(res.error)
    return `${t('twt_saved_to')} ${res.path}`
  })

  const openHistory = async (item: TeachingRecentItem) => {
    try {
      const parsed = normalizeDictation(await source.loadDraft('dictation', item.slug))
      if (!parsed) throw new Error(t('twt_dict_parse_failed'))
      accept(parsed)
      setStatus({ text: tf('twt_dict_loaded', { title: item.title }), tone: 'ok' })
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    }
  }

  const regenerate = async (item: TeachingRecentItem) => {
    try {
      const parsed = normalizeDictation(await source.loadDraft('dictation', item.slug))
      if (!parsed) throw new Error(t('twt_dict_parse_failed'))
      setBook(parsed.meta.book)
      setUnit(parsed.meta.unit)
      setKind(parsed.meta.kind)
      generate(parsed.meta.book, parsed.meta.unit, parsed.meta.kind)
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    }
  }

  const switchKind = (next: DictationKind) => {
    if (next === kind) return
    const oldLabel = kind === 'translation' ? t('twt_dict_kind_translation') : t('twt_dict_kind_dictation')
    const nextLabel = next === 'translation' ? t('twt_dict_kind_translation') : t('twt_dict_kind_dictation')
    setKind(next)
    setTitle((value) => (value.includes(oldLabel) ? value.replace(oldLabel, nextLabel) : value))
  }

  const bar = (
    <>
      <BarField label={t('twt_dict_book')} grow>
        <SelectOrType
          id="twt-dict-book"
          label={t('twt_dict_book')}
          value={book}
          choices={books}
          placeholder={t('twt_dict_book_ph')}
          onChange={setBook}
        />
      </BarField>
      <BarField label={t('twt_unit')} grow>
        <SelectOrType
          id="twt-dict-unit"
          label={t('twt_unit')}
          value={unit}
          choices={units}
          placeholder={t('twt_unit_ph')}
          onChange={setUnit}
        />
      </BarField>
      <BarField label={t('twt_dict_kind')}>
        <Segs<DictationKind>
          label={t('twt_dict_kind')}
          value={kind}
          options={DICTATION_KINDS}
          onChange={switchKind}
          labelOf={(value) => t(`twt_dict_kind_${value}`)}
        />
      </BarField>
      <BarField label={t('twt_dict_title')} grow>
        <input
          id="twt-dict-title"
          className="twb-input twt-input"
          value={title}
          placeholder={t('twt_dict_title_ph')}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (!title.trim()) setTitle(defaultTitle())
          }}
        />
      </BarField>
      <BarField label={t('twt_dict_words')}>
        <span className="twt-dict-bar-actions">
          <span className="twt-count">{tf('twt_dict_selected', { n: chosen.length, total: filledWords.length })}</span>
          <button
            type="button"
            className="twb-btn twb-btn-primary"
            onClick={skill.running ? skill.cancel : () => generate()}
          >
            {skill.running ? <Square size={14} /> : <Sparkles size={14} />}
            <span>{skill.running ? t('tw_teach_stop') : filledWords.length ? t('twt_dict_regen') : t('twt_dict_generate')}</span>
          </button>
        </span>
      </BarField>
    </>
  )

  const shownStatus: DeliverStatus = skill.error
    ? { text: skill.error, tone: 'error' }
    : skill.running
      ? { text: t('twt_running') }
      : status

  const actions = [
    { key: 'open', label: t('twt_dict_open_browser'), icon: ExternalLink, onClick: () => void doOpen(), primary: true, disabled: !draft || !chosen.length, busy: busy === 'open' },
    { key: 'html', label: t('twt_dict_save_html'), icon: FileDown, onClick: () => void doSaveHtml(), disabled: !draft || !chosen.length, busy: busy === 'html' },
    { key: 'pdf', label: t('twt_dict_export_pdf'), icon: Printer, onClick: () => void doPdf(), disabled: !draft || !chosen.length, busy: busy === 'pdf' },
  ]

  return (
    <ToolFrame
      tool="dictation"
      demo={Boolean(source.demo)}
      bar={bar}
      deliver={
        <DeliverBar
          status={shownStatus}
          actions={actions}
          extra={
            lastHtml ? (
              <button type="button" className="twb-link" onClick={() => void revealInFolder(lastHtml)}>
                {t('twt_reveal')}
              </button>
            ) : null
          }
        />
      }
    >
      <div className="twt-dict">
        <div className="twt-dict-left">
          {pasting && (
            <section className="twt-card twt-dict-paste">
              <div className="twt-card-head">
                <h2>{t('twt_dict_paste')}</h2>
              </div>
              <textarea
                className="twb-textarea"
                rows={7}
                value={paste}
                placeholder={t('twt_dict_paste_ph')}
                onChange={(e) => setPaste(e.target.value)}
              />
              <p className="twt-muted">{t('twt_dict_paste_hint')}</p>
              <div className="twt-dict-paste-actions">
                <button type="button" className="twb-btn twb-btn-primary" onClick={applyPaste}>
                  {t('twt_dict_paste_apply')}
                </button>
                <button type="button" className="twb-btn" onClick={() => setPasting(false)}>
                  {t('twt_dict_cancel')}
                </button>
              </div>
            </section>
          )}

          <section className="twt-card twt-dict-words">
            <div className="twt-card-head">
              <h2>{t('twt_dict_words')}</h2>
              <span className="twt-dict-head-tools">
                <span className="twt-count">{tf('twt_dict_selected', { n: chosen.length, total: filledWords.length })}</span>
                <button type="button" className="twb-link" onClick={() => setPasting((value) => !value)}>
                  {t('twt_dict_paste')}
                </button>
              </span>
            </div>
            {words.length ? (
              <>
                <label className="twt-dict-all">
                  <input
                    type="checkbox"
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = chosen.length > 0 && !allOn
                    }}
                    onChange={(e) => setAll(e.target.checked)}
                  />
                  <span>{t('twt_dict_select_all')}</span>
                </label>
                <datalist id="twt-dict-pos">
                  {POS_CHOICES.map((pos) => (
                    <option key={pos} value={pos} />
                  ))}
                </datalist>
                <ol className="twt-dict-list">
                  {words.map((word, index) => (
                    <li key={index} className={`twt-dict-row${on(word) ? '' : ' is-off'}`}>
                      <input
                        type="checkbox"
                        checked={on(word)}
                        aria-label={tf('twt_dict_pick_word', { n: index + 1 })}
                        onChange={(e) => patchWord(index, { on: e.target.checked })}
                      />
                      <span className="twt-dict-no">{index + 1}</span>
                      <input
                        className="twb-input twt-input twt-dict-word"
                        value={word.word}
                        aria-label={t('twt_dict_word')}
                        placeholder={t('twt_dict_word_ph')}
                        onChange={(e) => patchWord(index, { word: e.target.value })}
                      />
                      <input
                        className="twb-input twt-input twt-dict-phonetic"
                        value={word.phonetic || ''}
                        aria-label={t('twt_dict_phonetic')}
                        placeholder={t('twt_dict_phonetic_ph')}
                        onChange={(e) => patchWord(index, { phonetic: e.target.value })}
                      />
                      <div className="twt-dict-senses">
                        {word.senses.map((sense, senseIndex) => (
                          <div className="twt-dict-sense" key={senseIndex}>
                            <input
                              className="twb-input twt-input twt-dict-pos"
                              list="twt-dict-pos"
                              value={sense.pos}
                              aria-label={t('twt_dict_pos')}
                              placeholder={t('twt_dict_pos_ph')}
                              onChange={(e) => patchSense(index, senseIndex, { pos: e.target.value })}
                            />
                            <input
                              className="twb-input twt-input twt-dict-meaning"
                              value={sense.meaning}
                              aria-label={t('twt_dict_meaning')}
                              placeholder={t('twt_dict_meaning_ph')}
                              onChange={(e) => patchSense(index, senseIndex, { meaning: e.target.value })}
                            />
                            {senseIndex === word.senses.length - 1 && (
                              <button
                                type="button"
                                className="twt-dict-sense-add"
                                aria-label={t('twt_dict_add_sense')}
                                title={t('twt_dict_add_sense')}
                                onClick={() => addSense(index)}
                              >
                                ＋
                              </button>
                            )}
                            {word.senses.length > 1 && (
                              <button
                                type="button"
                                className="twt-dict-sense-del"
                                aria-label={t('twt_dict_remove_sense')}
                                title={t('twt_dict_remove_sense')}
                                onClick={() => removeSense(index, senseIndex)}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                        {!word.senses.length && (
                          <button type="button" className="twb-link" onClick={() => addSense(index)}>
                            ＋ {t('twt_dict_add_sense')}
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        className="twt-dict-del"
                        aria-label={t('twt_dict_remove_word')}
                        title={t('twt_dict_remove_word')}
                        onClick={() => removeWord(index)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ol>
                <button type="button" className="twt-dict-add-row" onClick={addWord}>
                  <b aria-hidden="true">＋</b>
                  <span>{t('twt_dict_add_word')}</span>
                </button>
              </>
            ) : skill.running ? (
              <Skeleton lines={6} height={22} />
            ) : (
              <>
                <StartHint
                  icon={CheckSquare}
                  text={t('twt_dict_start')}
                  actionLabel={t('twt_dict_paste')}
                  onAction={() => setPasting(true)}
                />
                <button type="button" className="twt-dict-add-row" onClick={addWord}>
                  <b aria-hidden="true">＋</b>
                  <span>{t('twt_dict_add_word')}</span>
                </button>
              </>
            )}
          </section>

          <section className="twt-card twt-hist">
            <div className="twt-card-head">
              <h2>{t('twt_dict_history')}</h2>
              {history.data.length > 0 && <span className="twt-count">{history.data.length}</span>}
            </div>
            {history.loading ? (
              <Skeleton lines={3} height={18} />
            ) : history.error ? (
              <p className="twt-muted">{history.error}</p>
            ) : history.data.length ? (
              <ul className="twt-hist-list">
                {history.data.map((item) => (
                  <li key={`${item.slug}-${item.when}`}>
                    <button type="button" className="twt-hist-open" onClick={() => void openHistory(item)}>
                      <History size={14} />
                      <span className="twt-hist-title">{item.title}</span>
                      <span className="twt-hist-when">{shortDate(item.when)}</span>
                    </button>
                    <button type="button" className="twb-link" onClick={() => void regenerate(item)}>
                      {t('twt_dict_regen_item')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="twt-muted">{t('twt_dict_history_empty')}</p>
            )}
          </section>
        </div>

        <aside className="twt-card twt-dict-preview">
          <div className="twt-card-head">
            <h2>{t('twt_dict_preview')}</h2>
          </div>
          <div className="twt-dict-sheet">
            {previewLoading && !preview ? (
              <Skeleton lines={8} height={20} />
            ) : previewError ? (
              <p className="twt-muted">{previewError}</p>
            ) : preview && chosen.length ? (
              <iframe
                title={t('twt_dict_preview')}
                className="twt-dict-frame"
                sandbox="allow-scripts"
                srcDoc={preview.html}
              />
            ) : (
              <p className="twt-muted twt-dict-empty">{t('twt_dict_preview_empty')}</p>
            )}
          </div>
          <p className="twt-muted twt-dict-hint">{t('twt_dict_sheet_hint')}</p>
        </aside>
      </div>
    </ToolFrame>
  )
}

export default DictationTool
