// 教学建议 — computed facts → judgement → actions that become board tasks
// (design §3.4). The facts strip is the system's numbers; the model only adds
// the judgement and the actions, and a follow-up carries the facts along.
import React, { useEffect, useState } from 'react'
import { ArrowUp, Check, ListTodo, Lightbulb, Sparkles, Square } from 'lucide-react'
import { t, tf } from '../../i18n'
import EmbeddedChat from '../../components/EmbeddedChat'
import DeliverBar, { type DeliverStatus } from '../../components/teaching/DeliverBar'
import FactsStrip from '../../components/teaching/FactsStrip'
import { ClassPicker } from '../../components/teaching/MaterialPicker'
import { Skeleton, StartHint } from '../../components/teaching/states'
import { DEMO_ACTIONS } from '../../components/teaching/demoData'
import { useChatStore } from '../../store/chatStore'
import { errorText } from '../../lib/teaching'
import { extractJson, normalizeActions, type AdviceAction } from './drafts'
import { ADVICE_FOCUS, ADVICE_RANGES, adviceFollowUp, advicePrompt } from './prompts'
import { useTeachingSource } from './source'
import { useLoad } from './useLoad'
import { useSkillRun } from './useSkillRun'
import ToolFrame, { BarField, Segs, sessionOf } from './ToolFrame'

const SESSION = sessionOf('advice')

const AdviceTool: React.FC = () => {
  const source = useTeachingSource()
  const skill = useSkillRun(SESSION)
  const send = useChatStore((s) => s.send)

  const [classId, setClassId] = useState('')
  const [unit, setUnit] = useState('')
  const [focus, setFocus] = useState(ADVICE_FOCUS[0])
  const [range, setRange] = useState(ADVICE_RANGES[0])
  const [actions, setActions] = useState<AdviceAction[]>([])
  // ?demo=1 opens with the actions already generated: the point of this page is
  // the fact → action shape, which an empty state cannot show.
  useEffect(() => {
    if (!source.demo) return
    setActions(DEMO_ACTIONS)
    setStatus({ text: tf('twt_actions_ready', { n: DEMO_ACTIONS.length }), tone: 'ok' })
    // Seed once per demo mount; a generated set replaces it afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.demo])
  const [adopted, setAdopted] = useState<Set<string>>(new Set())
  const [adopting, setAdopting] = useState('')
  const [question, setQuestion] = useState('')
  const [status, setStatus] = useState<DeliverStatus>({ text: '' })

  const classes = useLoad(source.classes, [], `c${source.demo}`)
  useEffect(() => {
    if (!classId && classes.data.length) setClassId(classes.data[0].id)
  }, [classes.data, classId])

  const facts = useLoad(() => source.facts(classId, unit), { facts: [], stats: {} }, `${source.demo}|${classId}|${unit}`, Boolean(classId))
  const className = classes.data.find((c) => c.id === classId)?.name || ''

  const generate = () => {
    if (!classId) {
      setStatus({ text: t('twt_need_class'), tone: 'warn' })
      return
    }
    setStatus({ text: t('twt_generating_advice') })
    if (source.demo) {
      setActions(DEMO_ACTIONS)
      setStatus({ text: tf('twt_actions_ready', { n: DEMO_ACTIONS.length }), tone: 'ok' })
      return
    }
    const params = { class_id: classId, class_name: className, unit, focus, range, facts: facts.data.facts }
    void skill.run(advicePrompt(params), `${t('twt_advice_display')} · ${className}`, (reply) => {
      const list = normalizeActions(extractJson(reply))
      if (!list.length) {
        setStatus({ text: t('twt_parse_failed'), tone: 'error' })
        return
      }
      setActions(list)
      setAdopted(new Set())
      setStatus({ text: tf('twt_actions_ready', { n: list.length }), tone: 'ok' })
    })
  }

  const adopt = async (action: AdviceAction) => {
    setAdopting(action.id)
    try {
      const note = [
        action.when && `${t('twt_when')}：${action.when}`,
        action.owner && `${t('twt_owner')}：${action.owner}`,
        ...action.steps.map((step, i) => `${i + 1}. ${step}`),
        action.expected && `${t('twt_expected')}：${action.expected}`,
      ]
        .filter(Boolean)
        .join('\n')
      await source.createTask({ title: action.title, note, status: 'todo' })
      setAdopted((prev) => new Set(prev).add(action.id))
      setStatus({ text: tf('twt_adopted', { title: action.title }), tone: 'ok' })
    } catch (err) {
      setStatus({ text: errorText(err), tone: 'error' })
    } finally {
      setAdopting('')
    }
  }

  const adoptAll = async () => {
    for (const action of actions) {
      if (!adopted.has(action.id)) await adopt(action)
    }
  }

  const ask = () => {
    const text = question.trim()
    if (!text || useChatStore.getState().sessions[SESSION]?.isStreaming) return
    setQuestion('')
    void send(SESSION, adviceFollowUp(text, facts.data.facts), [], text)
  }

  const shownStatus: DeliverStatus = skill.error
    ? { text: skill.error, tone: 'error' }
    : skill.running
      ? { text: t('twt_running') }
      : status

  const bar = (
    <>
      <BarField label={t('twt_class')} grow>
        <ClassPicker
          classes={classes.data}
          value={classId ? [classId] : []}
          onChange={(ids) => setClassId(ids[0] || '')}
          multi={false}
          loading={classes.loading}
          error={classes.error}
          onRetry={classes.reload}
        />
      </BarField>
      <BarField label={t('tw_f_unit')}>
        <input className="twb-input twt-input" value={unit} placeholder={t('twt_unit_ph')} onChange={(e) => setUnit(e.target.value)} />
      </BarField>
      <BarField label={t('tw_f_focus')}>
        <Segs label={t('tw_f_focus')} value={focus} options={ADVICE_FOCUS} onChange={setFocus} labelOf={(v) => t(`twt_focus_${ADVICE_FOCUS.indexOf(v)}`)} />
      </BarField>
      <BarField label={t('twt_range')}>
        <select className="twb-select twt-input" value={range} onChange={(e) => setRange(e.target.value)}>
          {ADVICE_RANGES.map((value, i) => (
            <option key={value} value={value}>
              {t(`twt_range_${i}`)}
            </option>
          ))}
        </select>
      </BarField>
    </>
  )

  const pending = actions.filter((a) => !adopted.has(a.id)).length
  const deliverActions = [
    {
      key: 'all',
      label: t('twt_adopt_all'),
      icon: ListTodo,
      onClick: () => void adoptAll(),
      primary: true,
      disabled: !pending,
      busy: Boolean(adopting),
    },
  ]

  return (
    <ToolFrame tool="advice" demo={Boolean(source.demo)} bar={bar} deliver={<DeliverBar status={shownStatus} actions={deliverActions} />}>
      <div className="twt-advice">
        <section className="twt-card twt-facts-card">
          <div className="twt-card-head">
            <h2>{t('twt_facts')}</h2>
            <span className="twt-muted">{t('twt_facts_hint')}</span>
          </div>
          {classId ? (
            <FactsStrip facts={facts.data.facts} loading={facts.loading} error={facts.error} onRetry={facts.reload} />
          ) : (
            <p className="twt-muted">{t('twt_evidence_need_class')}</p>
          )}
        </section>

        <section className="twt-card twt-actions-card">
          <div className="twt-card-head">
            <h2>{t('twt_actions')}</h2>
            <button type="button" className="twb-btn twb-btn-primary twt-btn-md" onClick={skill.running ? skill.cancel : generate}>
              {skill.running ? <Square size={14} /> : <Sparkles size={14} />}
              <span>{skill.running ? t('tw_teach_stop') : actions.length ? t('twt_regen_advice') : t('twt_gen_advice')}</span>
            </button>
          </div>
          {skill.running && !actions.length ? (
            <div className="twt-action-grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="twt-action is-skel">
                  <Skeleton lines={4} height={14} />
                </div>
              ))}
            </div>
          ) : actions.length ? (
            <ol className="twt-action-grid">
              {actions.map((action, i) => {
                const done = adopted.has(action.id)
                return (
                  <li key={action.id} className={`twt-action${done ? ' is-done' : ''}`}>
                    <div className="twt-action-head">
                      <span className="twt-action-no">{i + 1}</span>
                      <h3>{action.title}</h3>
                      <button
                        type="button"
                        className={`twt-btn-sm${done ? ' is-done' : ' is-primary'}`}
                        onClick={() => void adopt(action)}
                        disabled={done || adopting === action.id}
                      >
                        {done ? <Check size={13} /> : <ListTodo size={13} />}
                        <span>{done ? t('twt_adopted_short') : t('twt_adopt')}</span>
                      </button>
                    </div>
                    <div className="twt-action-meta">
                      {action.when && <span className="twt-tag">{action.when}</span>}
                      {action.owner && <span className="twt-tag is-owner">{action.owner}</span>}
                    </div>
                    {action.steps.length > 0 && (
                      <ul className="twt-action-steps">
                        {action.steps.map((step, k) => (
                          <li key={k}>{step}</li>
                        ))}
                      </ul>
                    )}
                    {action.expected && (
                      <p className="twt-action-expected">
                        <strong>{t('twt_expected')}</strong> {action.expected}
                      </p>
                    )}
                  </li>
                )
              })}
            </ol>
          ) : (
            <StartHint icon={Lightbulb} text={t('twt_advice_start')} actionLabel={t('twt_gen_advice')} onAction={generate} disabled={!classId} />
          )}
        </section>

        <section className="twt-card twt-followup">
          <div className="twt-card-head">
            <h2>{t('twt_followup')}</h2>
            <span className="twt-muted">{t('twt_followup_hint')}</span>
          </div>
          <div className="twt-followup-body">
            <EmbeddedChat sessionId={SESSION} />
          </div>
          <form
            className="twt-followup-bar"
            onSubmit={(e) => {
              e.preventDefault()
              ask()
            }}
          >
            <input
              className="twb-input twt-input"
              value={question}
              placeholder={t('tw_teach_input_ph')}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button type="submit" className="twb-icon-btn twt-send" aria-label={t('twt_send')} disabled={!question.trim()}>
              <ArrowUp size={15} />
            </button>
          </form>
        </section>
      </div>
    </ToolFrame>
  )
}

export default AdviceTool
