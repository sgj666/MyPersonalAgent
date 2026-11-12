// 教案 — materials on the left, the outline and then the manuscript on the
// right (design §3.1). Outline first because it is cheap to generate and
// quick to correct; the full text follows the corrected outline line by line.
import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BookOpenCheck, FilePen, Presentation, Save, Sparkles, Square } from 'lucide-react'
import { t } from '../../i18n'
import Markdown from '../../components/Markdown'
import DraftOutline from '../../components/teaching/DraftOutline'
import DeliverBar, { type DeliverStatus } from '../../components/teaching/DeliverBar'
import { filesUnder, knowledgeFiles, MaterialList, unitChoices, type MaterialGroup } from '../../components/teaching/MaterialPicker'
import { Skeleton, StartHint } from '../../components/teaching/states'
import { DEMO_OUTLINE, DEMO_PLAN_MD } from '../../components/teaching/demoData'
import { UnitPicker } from '../../components/teaching/MaterialPicker'
import { errorText } from '../../lib/teaching'
import { newId, parseOutline, slugify, type OutlineRow } from './drafts'
import { LESSON_TYPES, planDraftPrompt, planOutlinePrompt, STAGES, type PlanParams, KB } from './prompts'
import { useTeachingSource } from './source'
import { useLoad } from './useLoad'
import { useSkillRun } from './useSkillRun'
import ToolFrame, { BarField, sessionOf } from './ToolFrame'

const EMPTY_KNOWLEDGE = { tree: [], stats: { pages: 0, size: 0 }, enabled: true }

type Stage = 'outline' | 'draft'

const PlanTool: React.FC = () => {
  const source = useTeachingSource()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const skill = useSkillRun(sessionOf('plan'))

  const [meta, setMeta] = useState({
    stage: STAGES[1],
    subject: '',
    book: '',
    unit: params.get('unit') || '',
    lesson_type: LESSON_TYPES[1],
    hours: '1',
  })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [outline, setOutline] = useState<OutlineRow[]>([])
  const [fullText, setFullText] = useState('')
  const [editing, setEditing] = useState(false)
  const [view, setView] = useState<Stage>('outline')
  const [status, setStatus] = useState<DeliverStatus>({ text: '' })
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState('')

  const knowledge = useLoad(source.knowledge, EMPTY_KNOWLEDGE, `k${source.demo}`)
  const recentPlans = useLoad(() => source.recent('plan'), [], `p${source.demo}`)
  const recentCards = useLoad(() => source.recent('card'), [], `c${source.demo}`)
  const profile = useLoad(source.profile, {}, `pr${source.demo}`)

  // The teacher's own subject and textbook fill the empty fields once.
  useEffect(() => {
    const p = profile.data
    setMeta((m) => ({
      ...m,
      subject: m.subject || p.subjects?.[0] || '',
      book: m.book || p.textbook || '',
    }))
  }, [profile.data])

  const files = useMemo(() => knowledgeFiles(knowledge.data), [knowledge.data])
  const units = useMemo(() => unitChoices(files, KB.textbook), [files])

  const groups: MaterialGroup[] = useMemo(() => {
    const kb = (entries: { path: string; title: string }[]) =>
      entries.map((e) => ({ path: `knowledge/${e.path}`, title: e.title }))
    const unit = meta.unit.trim().toLowerCase()
    const textbook = kb(filesUnder(files, KB.textbook)).sort(
      (a, b) => Number(b.title.toLowerCase().includes(unit) && !!unit) - Number(a.title.toLowerCase().includes(unit) && !!unit)
    )
    return [
      { key: 'textbook', label: t('twt_mat_textbook'), items: textbook },
      { key: 'standard', label: t('twt_mat_standard'), items: kb(filesUnder(files, ...KB.standards)) },
      {
        key: 'plans',
        label: t('twt_mat_plans'),
        items: [
          ...kb(filesUnder(files, KB.plans)),
          ...recentPlans.data.map((r) => ({ path: r.rel, title: r.title, note: r.when })),
        ],
      },
      {
        key: 'feedback',
        label: t('twt_mat_feedback'),
        items: [
          ...kb(filesUnder(files, KB.feedback)),
          ...recentCards.data.map((r) => ({ path: r.rel, title: r.title, note: r.when })),
        ],
      },
    ]
  }, [files, recentPlans.data, recentCards.data, meta.unit])

  const planParams = (): PlanParams => ({ ...meta, material_paths: Array.from(picked) })
  const unitMissing = !meta.unit.trim()

  const generateOutline = () => {
    if (unitMissing) {
      setStatus({ text: t('twt_need_unit'), tone: 'warn' })
      return
    }
    setStatus({ text: t('twt_generating_outline') })
    if (source.demo) {
      setOutline(DEMO_OUTLINE.map((row) => ({ ...row, id: newId('o') })))
      setStatus({ text: t('twt_outline_ready'), tone: 'ok' })
      return
    }
    void skill.run(planOutlinePrompt(planParams()), `${t('twt_plan_outline_display')} · ${meta.unit}`, (reply) => {
      const rows = parseOutline(reply)
      if (!rows.length) {
        setStatus({ text: t('twt_parse_failed'), tone: 'error' })
        return
      }
      setOutline(rows)
      setView('outline')
      setStatus({ text: t('twt_outline_ready'), tone: 'ok' })
    })
  }

  const generateDraft = () => {
    setStatus({ text: t('twt_generating_draft') })
    if (source.demo) {
      setFullText(DEMO_PLAN_MD)
      setView('draft')
      setStatus({ text: t('twt_draft_ready'), tone: 'ok' })
      return
    }
    void skill.run(planDraftPrompt(planParams(), outline), `${t('twt_plan_draft_display')} · ${meta.unit}`, (reply) => {
      setFullText(reply.trim())
      setView('draft')
      setStatus({ text: t('twt_draft_ready'), tone: 'ok' })
    })
  }

  const knowledgePath = `${KB.plans}/${slugify([meta.stage, meta.subject, meta.unit, meta.lesson_type].filter(Boolean).join('-'))}.md`

  const save = async () => {
    setSaving(true)
    try {
      try {
        await source.saveKnowledge(knowledgePath, fullText, false)
      } catch (err) {
        // The draft step may already have written this page; overwrite only on a yes.
        if (!window.confirm(t('twt_overwrite_confirm').replace('{path}', knowledgePath))) throw err
        await source.saveKnowledge(knowledgePath, fullText, true)
      }
      setSavedPath(knowledgePath)
      setStatus({ text: `${t('twt_saved_to')} knowledge/${knowledgePath}`, tone: 'ok' })
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const toCourseware = () => {
    const qs = new URLSearchParams({ tool: 'courseware', unit: meta.unit })
    if (savedPath) qs.set('plan', `knowledge/${savedPath}`)
    if (source.demo) qs.set('demo', source.demo)
    navigate(`/teaching?${qs.toString()}`)
  }

  const shownStatus: DeliverStatus = skill.error
    ? { text: skill.error, tone: 'error' }
    : skill.running
      ? { text: t('twt_running') }
      : status

  const set = (key: keyof typeof meta) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setMeta((m) => ({ ...m, [key]: e.target.value }))

  const bar = (
    <>
      <BarField label={t('tw_f_stage')}>
        <select className="twb-select twt-input" value={meta.stage} onChange={set('stage')}>
          {STAGES.map((value, i) => (
            <option key={value} value={value}>
              {t(`twt_stage_${i}`)}
            </option>
          ))}
        </select>
      </BarField>
      <BarField label={t('tw_f_subject')}>
        <input className="twb-input twt-input is-short" value={meta.subject} onChange={set('subject')} />
      </BarField>
      <BarField label={t('tw_f_book')}>
        <input className="twb-input twt-input" value={meta.book} onChange={set('book')} />
      </BarField>
      <BarField label={t('tw_f_unit')} grow>
        <UnitPicker id="twt-plan" value={meta.unit} onChange={(unit) => setMeta((m) => ({ ...m, unit }))} choices={units} />
      </BarField>
      <BarField label={t('tw_f_lesson_type')}>
        <select className="twb-select twt-input" value={meta.lesson_type} onChange={set('lesson_type')}>
          {LESSON_TYPES.map((value, i) => (
            <option key={value} value={value}>
              {t(`twt_lesson_${i}`)}
            </option>
          ))}
        </select>
      </BarField>
      <BarField label={t('tw_f_hours')}>
        <input className="twb-input twt-input is-num" type="number" min={1} max={20} value={meta.hours} onChange={set('hours')} />
      </BarField>
    </>
  )

  const actions = [
    {
      key: 'save',
      label: t('twt_save_knowledge'),
      icon: Save,
      onClick: () => void save(),
      disabled: !fullText,
      busy: saving,
    },
    {
      key: 'courseware',
      label: t('twt_to_courseware'),
      icon: Presentation,
      onClick: toCourseware,
      primary: Boolean(fullText),
      disabled: unitMissing,
    },
  ]

  return (
    <ToolFrame
      tool="plan"
      demo={Boolean(source.demo)}
      bar={bar}
      deliver={<DeliverBar status={shownStatus} actions={actions} />}
    >
      <div className="twt-plan">
        <aside className="twt-card twt-plan-side" aria-label={t('twt_mat_title')}>
          <div className="twt-card-head">
            <h2>{t('twt_mat_title')}</h2>
            <span className="twt-count">{picked.size}</span>
          </div>
          <MaterialList
            groups={groups}
            selected={picked}
            onToggle={(path) =>
              setPicked((prev) => {
                const next = new Set(prev)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
            loading={knowledge.loading}
            error={knowledge.error}
            onRetry={knowledge.reload}
          />
        </aside>

        <section className="twt-card twt-plan-paper">
          <div className="twt-card-head">
            <div className="twt-steps" role="tablist" aria-label={t('twt_plan_steps')}>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'outline'}
                className={`twt-step${view === 'outline' ? ' is-on' : ''}`}
                onClick={() => setView('outline')}
              >
                <span className="twt-step-no">1</span>
                {t('twt_outline')}
              </button>
              <span className="twt-step-sep" aria-hidden="true" />
              <button
                type="button"
                role="tab"
                aria-selected={view === 'draft'}
                className={`twt-step${view === 'draft' ? ' is-on' : ''}`}
                onClick={() => setView('draft')}
                disabled={!fullText}
              >
                <span className="twt-step-no">2</span>
                {t('twt_fulltext')}
              </button>
            </div>
            <div className="twt-head-actions">
              {skill.running ? (
                <button type="button" className="twb-btn twt-btn-md" onClick={skill.cancel}>
                  <Square size={14} />
                  <span>{t('tw_teach_stop')}</span>
                </button>
              ) : view === 'outline' && outline.length ? (
                <>
                  <button type="button" className="twb-btn twt-btn-md" onClick={generateOutline}>
                    <Sparkles size={14} />
                    <span>{t('twt_regen_outline')}</span>
                  </button>
                  <button type="button" className="twb-btn twb-btn-primary twt-btn-md" onClick={generateDraft}>
                    <BookOpenCheck size={14} />
                    <span>{t('twt_gen_fulltext')}</span>
                  </button>
                </>
              ) : view === 'draft' && fullText ? (
                <button type="button" className="twb-btn twt-btn-md" onClick={() => setEditing((v) => !v)}>
                  <FilePen size={14} />
                  <span>{editing ? t('twt_preview') : t('twt_edit')}</span>
                </button>
              ) : null}
            </div>
          </div>

          {view === 'outline' ? (
            skill.running && !outline.length ? (
              <Skeleton lines={7} height={18} />
            ) : outline.length ? (
              <DraftOutline
                label={t('twt_outline')}
                items={outline}
                keyOf={(row) => row.id}
                onChange={setOutline}
                onAdd={() => setOutline((rows) => [...rows, { id: newId('o'), title: '', point: '', time: '' }])}
                addLabel={t('twt_add_line')}
                renderRow={(row, _i, update) => (
                  <div className="twt-outline-line">
                    <input
                      className="twt-cell is-strong"
                      value={row.title}
                      placeholder={t('twt_section_ph')}
                      onChange={(e) => update({ ...row, title: e.target.value })}
                    />
                    <input
                      className="twt-cell is-grow"
                      value={row.point}
                      placeholder={t('twt_point_ph')}
                      onChange={(e) => update({ ...row, point: e.target.value })}
                    />
                    <input
                      className="twt-cell is-time"
                      value={row.time}
                      placeholder={t('twt_time_ph')}
                      onChange={(e) => update({ ...row, time: e.target.value })}
                    />
                  </div>
                )}
                renderDetail={(row, _i, update) => (
                  <textarea
                    className="twb-textarea twt-detail-text"
                    rows={3}
                    value={row.point}
                    onChange={(e) => update({ ...row, point: e.target.value })}
                  />
                )}
              />
            ) : (
              <StartHint
                icon={FilePen}
                text={t('twt_plan_start')}
                actionLabel={t('twt_gen_outline')}
                onAction={generateOutline}
                disabled={skill.running}
              />
            )
          ) : editing ? (
            <textarea
              className="twt-paper-edit"
              value={fullText}
              onChange={(e) => setFullText(e.target.value)}
              aria-label={t('twt_fulltext')}
            />
          ) : (
            <article className="twt-paper">
              <Markdown content={fullText} />
            </article>
          )}
        </section>
      </div>
    </ToolFrame>
  )
}

export default PlanTool
