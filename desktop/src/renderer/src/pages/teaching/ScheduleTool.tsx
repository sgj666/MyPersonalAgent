// 教学计划 — an editable week table checked against the timetable and the
// progress already taught (design §3.5). The weeks are data: 写入教学进度
// imports them with overwrite=false, so taught rows are never touched.
import React, { useEffect, useMemo, useState } from 'react'
import { CalendarDays, CalendarPlus, Download, FoldVertical, Plus, Sparkles, Square, Upload } from 'lucide-react'
import { t, tf } from '../../i18n'
import type { TeachingWeek } from '../../api/client'
import DeliverBar, { type DeliverStatus } from '../../components/teaching/DeliverBar'
import DraftOutline from '../../components/teaching/DraftOutline'
import { ClassPicker } from '../../components/teaching/MaterialPicker'
import { InlineError, Skeleton, StartHint } from '../../components/teaching/states'
import { DEMO_WEEKS } from '../../components/teaching/demoData'
import { errorText } from '../../lib/teaching'
import { compressWeeks, extractJson, newId, normalizeWeeks, renumberWeeks } from './drafts'
import { REVIEW_TOPIC, schedulePrompt } from './prompts'
import { useTeachingSource } from './source'
import { useLoad } from './useLoad'
import { useSkillRun } from './useSkillRun'
import ToolFrame, { BarField, sessionOf } from './ToolFrame'

const DEFAULT_WEEKS = 18
const DEFAULT_PERIODS = 5

interface WeekRow extends TeachingWeek {
  key: string
}

const toRows = (weeks: TeachingWeek[]): WeekRow[] => weeks.map((w) => ({ ...w, key: newId('w') }))
const fromRows = (rows: WeekRow[], start: number): TeachingWeek[] =>
  renumberWeeks(
    rows.map(({ key: _key, ...week }) => week),
    start
  )

/** CSV with a BOM so Excel opens the Chinese text correctly. */
function toCsv(weeks: TeachingWeek[], headers: string[]): string {
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const lines = [headers.map(cell).join(','), ...weeks.map((w) => [w.week, w.unit, w.topic, w.periods, w.goal, w.assess].map(cell).join(','))]
  return '﻿' + lines.join('\r\n')
}

const ScheduleTool: React.FC = () => {
  const source = useTeachingSource()
  const skill = useSkillRun(sessionOf('schedule'))

  const [term, setTerm] = useState('')
  const [book, setBook] = useState('')
  const [weeks, setWeeks] = useState(DEFAULT_WEEKS)
  // ?demo=1 opens on a filled term table; an empty grid cannot show what the
  // reconcile column and the write-back button are for.
  useEffect(() => {
    if (!source.demo) return
    setRows(toRows(DEMO_WEEKS))
    setStatus({ text: tf('twt_weeks_ready', { n: DEMO_WEEKS.length }), tone: 'ok' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.demo])
  const [startWeek, setStartWeek] = useState(1)
  const [perWeek, setPerWeek] = useState(DEFAULT_PERIODS)
  const [scope, setScope] = useState('')
  const [classIds, setClassIds] = useState<string[]>([])
  const [rows, setRows] = useState<WeekRow[]>([])
  const [selected, setSelected] = useState(-1)
  const [squeezeTo, setSqueezeTo] = useState(DEFAULT_WEEKS - 2)
  const [status, setStatus] = useState<DeliverStatus>({ text: '' })
  const [importing, setImporting] = useState(false)

  const classes = useLoad(source.classes, [], `c${source.demo}`)
  const timetable = useLoad(source.timetable, { periods: [], slots: [], overrides: [] }, `t${source.demo}`)
  const firstClass = classIds[0] || ''
  const progress = useLoad(() => source.progress(firstClass), [], `${source.demo}|${firstClass}`, Boolean(firstClass))

  const tableWeeks = useMemo(() => fromRows(rows, startWeek), [rows, startWeek])

  // ---------- 对账 ----------
  const checks = useMemo(() => {
    const out: { tone: 'ok' | 'warn'; text: string }[] = []
    if (!rows.length) return out
    if (rows.length !== weeks) out.push({ tone: 'warn', text: tf('twt_chk_weeks', { rows: rows.length, weeks }) })
    const total = tableWeeks.reduce((n, w) => n + w.periods, 0)
    const capacity = weeks * perWeek
    out.push({ tone: total > capacity ? 'warn' : 'ok', text: tf('twt_chk_total', { total, capacity }) })
    for (const id of classIds) {
      const name = classes.data.find((c) => c.id === id)?.name || id
      const slots = timetable.data.slots.filter((s) => s.class_id === id && s.kind === 'regular' && s.mine !== false).length
      if (!slots) {
        out.push({ tone: 'warn', text: tf('twt_chk_no_slots', { name }) })
        continue
      }
      const over = tableWeeks.filter((w) => w.periods > slots)
      if (perWeek > slots) out.push({ tone: 'warn', text: tf('twt_chk_slots', { name, slots, plan: perWeek }) })
      if (over.length) out.push({ tone: 'warn', text: tf('twt_chk_over', { name, weeks: over.map((w) => w.week).join('、'), slots }) })
      if (perWeek <= slots && !over.length) out.push({ tone: 'ok', text: tf('twt_chk_slots_ok', { name, slots }) })
    }
    return out
  }, [rows.length, weeks, perWeek, tableWeeks, classIds, classes.data, timetable.data])

  const taught = progress.data.filter((p) => p.taught_periods > 0)

  // ---------- table operations ----------
  const autoPlan = () => {
    setStatus({ text: t('twt_generating_weeks') })
    if (source.demo) {
      setRows(toRows(DEMO_WEEKS))
      setStatus({ text: tf('twt_weeks_ready', { n: DEMO_WEEKS.length }), tone: 'ok' })
      return
    }
    const params = { term, book, weeks, start_week: startWeek, periods_per_week: perWeek, class_ids: classIds, scope }
    void skill.run(schedulePrompt(params, tableWeeks), `${t('twt_schedule_display')} · ${term || book}`, (reply) => {
      const list = normalizeWeeks(extractJson(reply))
      if (!list.length) {
        setStatus({ text: t('twt_parse_failed'), tone: 'error' })
        return
      }
      setRows(toRows(list))
      setStatus({ text: tf('twt_weeks_ready', { n: list.length }), tone: 'ok' })
    })
  }

  const squeeze = () => {
    if (rows.length <= squeezeTo) {
      setStatus({ text: tf('twt_squeeze_noop', { n: rows.length }), tone: 'warn' })
      return
    }
    setRows(toRows(compressWeeks(tableWeeks, squeezeTo)))
    setWeeks(squeezeTo)
    setStatus({ text: tf('twt_squeezed', { n: squeezeTo }), tone: 'ok' })
  }

  const insertReview = () => {
    const at = selected >= 0 ? selected + 1 : Math.ceil(rows.length / 2)
    const review: WeekRow = { key: newId('w'), week: 0, unit: '', topic: REVIEW_TOPIC, periods: perWeek, goal: '', assess: '' }
    setRows((prev) => [...prev.slice(0, at), review, ...prev.slice(at)])
    setSelected(at)
  }

  const addRow = () => setRows((prev) => [...prev, { key: newId('w'), week: 0, unit: '', topic: '', periods: perWeek, goal: '', assess: '' }])

  // ---------- delivery ----------
  const write = async () => {
    if (!classIds.length) {
      setStatus({ text: t('twt_need_class'), tone: 'warn' })
      return
    }
    setImporting(true)
    try {
      const res = await source.importProgress(classIds, tableWeeks)
      setStatus({ text: tf('twt_imported', { created: res.created, skipped: res.skipped }), tone: res.conflicts.length ? 'warn' : 'ok' })
      progress.reload()
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    } finally {
      setImporting(false)
    }
  }

  const exportCsv = () => {
    const headers = ['twt_col_week', 'twt_col_unit', 'twt_col_topic', 'twt_col_periods', 'twt_col_goal', 'twt_col_assess'].map(t)
    const blob = new Blob([toCsv(tableWeeks, headers)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${term || t('tw_tool_schedule')}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setStatus({ text: t('twt_csv_done'), tone: 'ok' })
  }

  const shownStatus: DeliverStatus = skill.error
    ? { text: skill.error, tone: 'error' }
    : skill.running
      ? { text: t('twt_running') }
      : status

  const num = (setter: (n: number) => void, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setter(Math.max(min, Math.min(max, Number(e.target.value) || min)))

  const bar = (
    <>
      <BarField label={t('tw_f_term')}>
        <input className="twb-input twt-input" value={term} placeholder={t('twt_term_ph')} onChange={(e) => setTerm(e.target.value)} />
      </BarField>
      <BarField label={t('tw_f_book')}>
        <input className="twb-input twt-input" value={book} onChange={(e) => setBook(e.target.value)} />
      </BarField>
      <BarField label={t('tw_f_weeks')}>
        <input className="twb-input twt-input is-num" type="number" min={1} max={30} value={weeks} onChange={num(setWeeks, 1, 30)} />
      </BarField>
      <BarField label={t('twt_start_week')}>
        <input className="twb-input twt-input is-num" type="number" min={1} max={30} value={startWeek} onChange={num(setStartWeek, 1, 30)} />
      </BarField>
      <BarField label={t('twt_per_week')}>
        <input className="twb-input twt-input is-num" type="number" min={1} max={20} value={perWeek} onChange={num(setPerWeek, 1, 20)} />
      </BarField>
      <BarField label={t('twt_classes')} grow>
        <ClassPicker classes={classes.data} value={classIds} onChange={setClassIds} loading={classes.loading} error={classes.error} onRetry={classes.reload} />
      </BarField>
    </>
  )

  const actions = [
    { key: 'write', label: t('twt_write_progress'), icon: Upload, onClick: () => void write(), primary: true, disabled: !rows.length, busy: importing },
    { key: 'csv', label: t('twt_export_table'), icon: Download, onClick: exportCsv, disabled: !rows.length },
  ]

  return (
    <ToolFrame tool="schedule" demo={Boolean(source.demo)} bar={bar} deliver={<DeliverBar status={shownStatus} actions={actions} />}>
      <div className="twt-schedule">
        <section className="twt-card twt-weeks">
          <div className="twt-card-head">
            <h2>{t('twt_weeks_table')}</h2>
            <div className="twt-head-actions">
              <button type="button" className="twb-btn twb-btn-primary twt-btn-md" onClick={skill.running ? skill.cancel : autoPlan}>
                {skill.running ? <Square size={14} /> : <Sparkles size={14} />}
                <span>{skill.running ? t('tw_teach_stop') : t('twt_auto_plan')}</span>
              </button>
              <span className="twt-squeeze">
                <input
                  className="twb-input twt-input is-num"
                  type="number"
                  min={1}
                  max={30}
                  value={squeezeTo}
                  aria-label={t('twt_squeeze_to')}
                  onChange={num(setSqueezeTo, 1, 30)}
                />
                <button type="button" className="twb-btn twt-btn-md" onClick={squeeze} disabled={!rows.length}>
                  <FoldVertical size={14} />
                  <span>{tf('twt_squeeze', { n: squeezeTo })}</span>
                </button>
              </span>
              <button type="button" className="twb-btn twt-btn-md" onClick={insertReview} disabled={!rows.length}>
                <CalendarPlus size={14} />
                <span>{t('twt_insert_review')}</span>
              </button>
            </div>
          </div>

          {!rows.length && !skill.running ? (
            <div className="twt-weeks-start">
              <StartHint icon={CalendarDays} text={t('twt_schedule_start')} actionLabel={t('twt_auto_plan')} onAction={autoPlan} />
              <label className="twt-scope">
                <span>{t('tw_f_scope')}</span>
                <textarea className="twb-textarea" rows={2} value={scope} placeholder={t('twt_scope_ph')} onChange={(e) => setScope(e.target.value)} />
              </label>
              <button type="button" className="twb-link" onClick={addRow}>
                <Plus size={13} />
                <span>{t('twt_blank_table')}</span>
              </button>
            </div>
          ) : skill.running && !rows.length ? (
            <Skeleton lines={8} height={26} />
          ) : (
            <div className="twt-week-table">
              <div className="twt-week-head" aria-hidden="true">
                <span />
                <span>{t('twt_col_week')}</span>
                <span>{t('twt_col_unit')}</span>
                <span>{t('twt_col_topic')}</span>
                <span>{t('twt_col_periods')}</span>
                <span>{t('twt_col_goal')}</span>
                <span>{t('twt_col_assess')}</span>
                <span />
              </div>
              <DraftOutline<WeekRow>
                label={t('twt_weeks_table')}
                className="is-table"
                items={rows}
                keyOf={(r) => r.key}
                onChange={setRows}
                selected={selected}
                onSelect={setSelected}
                numbered={false}
                onAdd={addRow}
                addLabel={t('twt_add_week')}
                renderRow={(row, index, update) => {
                  const cell = (key: 'unit' | 'topic' | 'goal' | 'assess', cls = '') => (
                    <input
                      className={`twt-cell${cls}`}
                      value={row[key]}
                      aria-label={t(`twt_col_${key}`)}
                      onChange={(e) => update({ ...row, [key]: e.target.value })}
                    />
                  )
                  const slotsMax = Math.min(
                    ...classIds.map((id) => timetable.data.slots.filter((s) => s.class_id === id && s.kind === 'regular' && s.mine !== false).length || Infinity)
                  )
                  const overflow = row.periods > slotsMax
                  return (
                    <span className={`twt-week-row${row.topic === REVIEW_TOPIC ? ' is-review' : ''}`}>
                      <span className="twt-week-no">{tf('twt_week_n', { n: startWeek + index })}</span>
                      {cell('unit')}
                      {cell('topic')}
                      <input
                        className={`twt-cell is-num${overflow ? ' is-warn' : ''}`}
                        type="number"
                        min={0}
                        value={row.periods}
                        aria-label={t('twt_col_periods')}
                        title={overflow ? t('twt_cell_over') : undefined}
                        onChange={(e) => update({ ...row, periods: Math.max(0, Number(e.target.value) || 0) })}
                      />
                      {cell('goal')}
                      {cell('assess')}
                    </span>
                  )
                }}
              />
            </div>
          )}
        </section>

        <aside className="twt-card twt-recon" aria-label={t('twt_recon')}>
          <div className="twt-card-head">
            <h2>{t('twt_recon')}</h2>
          </div>
          {timetable.error && <InlineError message={timetable.error} onRetry={timetable.reload} />}
          {timetable.loading ? (
            <Skeleton lines={3} />
          ) : checks.length ? (
            <ul className="twt-checks">
              {checks.map((c, i) => (
                <li key={i} className={`twt-check is-${c.tone}`}>
                  {c.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="twt-muted">{t('twt_recon_empty')}</p>
          )}

          <h3 className="twt-sub">{t('twt_taught')}</h3>
          {!firstClass ? (
            <p className="twt-muted">{t('twt_evidence_need_class')}</p>
          ) : progress.loading ? (
            <Skeleton lines={3} />
          ) : progress.error ? (
            <InlineError message={progress.error} onRetry={progress.reload} />
          ) : taught.length ? (
            <ul className="twt-checks">
              {taught.map((p) => (
                <li key={p.id} className="twt-check is-info">
                  {tf('twt_taught_item', { topic: p.topic, taught: p.taught_periods, planned: p.planned_periods })}
                </li>
              ))}
            </ul>
          ) : (
            <p className="twt-muted">{t('twt_taught_none')}</p>
          )}
          <p className="twt-muted twt-recon-foot">{t('twt_no_overwrite')}</p>
        </aside>
      </div>
    </ToolFrame>
  )
}

export default ScheduleTool
