import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  CalendarDays,
  Copy,
  ExternalLink,
  FileText,
  Lightbulb,
  Presentation,
  Sparkles,
  Square,
  type LucideIcon,
} from 'lucide-react'
import { t } from '../i18n'
import EmbeddedChat from '../components/EmbeddedChat'
import { useChatStore } from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'

type ToolId = 'plan' | 'courseware' | 'card' | 'advice' | 'schedule'

interface Choice {
  value: string
  /** Shown in the picker; also the text the prompt carries. */
  label: string
}

interface FieldDef {
  name: string
  labelKey: string
  type: 'text' | 'number' | 'select' | 'textarea'
  defaultValue: string
  placeholder?: string
  choices?: Choice[]
  min?: number
  max?: number
  required?: boolean
  /** Share a row with the field that follows it. */
  half?: boolean
}

interface ToolDef {
  id: ToolId
  labelKey: string
  descKey: string
  /** The Skill the prompt names; the page never lets the Agent pick one. */
  skill: string
  icon: LucideIcon
  fields: FieldDef[]
}

const choices = (...values: string[]): Choice[] => values.map((value) => ({ value, label: value }))

/**
 * The five forms, transcribed from the web console
 * (channel/web/static/js/views/teaching.js). Choice values are the Chinese the
 * prompt quotes, so the prompt carries exactly what the teacher picked.
 */
const TOOLS: ToolDef[] = [
  {
    id: 'plan',
    labelKey: 'tw_tool_plan',
    descKey: 'tw_tool_plan_desc',
    skill: 'lesson-plan',
    icon: FileText,
    fields: [
      {
        name: 'stage',
        labelKey: 'tw_f_stage',
        type: 'select',
        defaultValue: '初中',
        choices: choices('小学', '初中', '高中'),
        half: true,
      },
      { name: 'subject', labelKey: 'tw_f_subject', type: 'text', defaultValue: '英语', required: true },
      { name: 'book', labelKey: 'tw_f_book', type: 'text', defaultValue: '人教新版', half: true },
      {
        name: 'unit',
        labelKey: 'tw_f_unit',
        type: 'text',
        defaultValue: '',
        placeholder: 'Unit 3 My weekend plan',
        required: true,
      },
      {
        name: 'lesson_type',
        labelKey: 'tw_f_lesson_type',
        type: 'select',
        defaultValue: '读写课',
        choices: choices('新授课', '读写课', '听说课', '复习课', '习题课'),
        half: true,
      },
      { name: 'hours', labelKey: 'tw_f_hours', type: 'number', defaultValue: '2', min: 1, max: 20 },
      {
        name: 'goal',
        labelKey: 'tw_f_goal',
        type: 'textarea',
        defaultValue: '',
        placeholder: '例：能运用 be going to 描述周末计划；能读懂并复述课文。',
      },
    ],
  },
  {
    id: 'courseware',
    labelKey: 'tw_tool_courseware',
    descKey: 'tw_tool_courseware_desc',
    skill: 'courseware-ppt',
    icon: Presentation,
    fields: [
      {
        name: 'unit',
        labelKey: 'tw_f_unit',
        type: 'text',
        defaultValue: '',
        placeholder: 'Unit 3 My weekend plan',
        required: true,
      },
      {
        name: 'source',
        labelKey: 'tw_f_lesson_source',
        type: 'select',
        defaultValue: '根据本课题新建教案',
        choices: choices('根据本课题新建教案', '使用知识库中已有的教案'),
        half: true,
      },
      {
        name: 'template',
        labelKey: 'tw_f_template',
        type: 'select',
        defaultValue: '讲授',
        choices: choices('讲授', '活动', '复习'),
      },
      { name: 'slides', labelKey: 'tw_f_slides', type: 'number', defaultValue: '15', min: 5, max: 60 },
    ],
  },
  {
    id: 'card',
    labelKey: 'tw_tool_card',
    descKey: 'tw_tool_card_desc',
    skill: 'homework-card',
    icon: Copy,
    fields: [
      {
        name: 'source',
        labelKey: 'tw_f_source',
        type: 'textarea',
        defaultValue: '',
        placeholder: '例：Unit 3 课文与词汇；或粘贴题目原文。',
        required: true,
      },
      {
        name: 'layout',
        labelKey: 'tw_f_layout',
        type: 'select',
        defaultValue: '单栏练习',
        choices: choices('单栏练习', '双栏练习', '四宫格'),
        half: true,
      },
      { name: 'count', labelKey: 'tw_f_count', type: 'number', defaultValue: '10', min: 1, max: 50 },
    ],
  },
  {
    id: 'advice',
    labelKey: 'tw_tool_advice',
    descKey: 'tw_tool_advice_desc',
    skill: 'teaching-advice',
    icon: Lightbulb,
    fields: [
      {
        name: 'class_name',
        labelKey: 'tw_f_class',
        type: 'text',
        defaultValue: '',
        placeholder: '例：七年级 (3) 班，48 人，基础一般',
        required: true,
      },
      {
        name: 'unit',
        labelKey: 'tw_f_unit',
        type: 'text',
        defaultValue: '',
        placeholder: 'Unit 3 My weekend plan',
      },
      {
        name: 'focus',
        labelKey: 'tw_f_focus',
        type: 'textarea',
        defaultValue: '',
        placeholder: '例：课堂参与度、分层任务、读写结合。',
      },
    ],
  },
  {
    id: 'schedule',
    labelKey: 'tw_tool_schedule',
    descKey: 'tw_tool_schedule_desc',
    skill: 'teaching-plan',
    icon: CalendarDays,
    fields: [
      {
        name: 'term',
        labelKey: 'tw_f_term',
        type: 'text',
        defaultValue: '',
        placeholder: '2026 学年第二学期',
        required: true,
        half: true,
      },
      { name: 'weeks', labelKey: 'tw_f_weeks', type: 'number', defaultValue: '18', min: 1, max: 30 },
      {
        name: 'scope',
        labelKey: 'tw_f_scope',
        type: 'textarea',
        defaultValue: '',
        placeholder: '例：七年级上册 Unit 1–Unit 6，每单元 2–3 课时。',
      },
    ],
  },
]

const TOOL_IDS: ToolId[] = TOOLS.map((tool) => tool.id)

const asToolId = (value: string): ToolId | null =>
  TOOL_IDS.includes(value as ToolId) ? (value as ToolId) : null

/** Field rows: a `half` field and its successor share one row. */
function rowsOf(fields: FieldDef[]): FieldDef[][] {
  const rows: FieldDef[][] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const next = fields[i + 1]
    if (field.half && next) {
      rows.push([field, next])
      i++
    } else {
      rows.push([field])
    }
  }
  return rows
}

function defaultValues(): Record<ToolId, Record<string, string>> {
  const out = {} as Record<ToolId, Record<string, string>>
  TOOLS.forEach((tool) => {
    const values: Record<string, string> = {}
    tool.fields.forEach((field) => {
      values[field.name] = field.defaultValue
    })
    out[tool.id] = values
  })
  return out
}

/**
 * The Chinese request each form turns into. Every prompt names its Skill and
 * spells out the sections the answer must carry, so the same tool produces the
 * same shape in the web console and here; an empty field reads 未填写 rather
 * than dropping its line.
 */
function buildPrompt(tool: ToolId, skill: string, values: Record<string, string>): string {
  const v = (key: string) => (values[key] ? values[key].trim() : '未填写')
  if (tool === 'plan') {
    return [
      `请使用 skill「${skill}」生成一份教案，按 Markdown 输出。`,
      `学段：${v('stage')}`,
      `学科：${v('subject')}`,
      `教材版本：${v('book')}`,
      `单元 / 课题：${v('unit')}`,
      `课型：${v('lesson_type')}`,
      `课时：${v('hours')} 课时`,
      `教学目标：${v('goal')}`,
      '',
      '输出结构（按此顺序，标题必须保留）：',
      '1. 教学目标：知识、能力、素养各一条，行为动词可观察。',
      '2. 教学重难点：分开写重点与难点，并说明依据。',
      '3. 教学准备：教具、板书、学生前置任务。',
      '4. 教学过程：分环节，每环节标注时长，并列出教师活动 / 学生活动 / 设计意图。',
      '5. 板书设计：用代码块画出板面布局。',
      '6. 作业布置：基础与提升两档，各写明预计用时。',
      '7. 课后反思：留 3 条可观察的观察点。',
      '',
      '语言面向教师，可直接照着上课；引用教材内容请注明出处。',
    ].join('\n')
  }
  if (tool === 'courseware') {
    return [
      `请使用 skill「${skill}」生成一套课件（.pptx）。`,
      `单元 / 课题：${v('unit')}`,
      `教案来源：${v('source')}`,
      `母版模板：${v('template')}`,
      `页数：约 ${v('slides')} 页`,
      '',
      '输出结构：',
      '1. 先给出页面清单：页码 / 标题 / 要点 / 备注稿，一页一行。',
      '2. 第 1 页封面（课题、学段学科、教师），第 2 页目录，最后 1 页小结与作业。',
      `3. 使用「${v('template')}」母版；只用主题字体，不嵌字体，避免跨机版式错乱。`,
      '4. 每页要点不超过 5 条，备注稿写成教师口播稿。',
      '5. 输出真实 .pptx 文件到产出目录，完成后告诉我文件路径。',
    ].join('\n')
  }
  if (tool === 'card') {
    return [
      `请使用 skill「${skill}」生成一份作业卡片（单文件 HTML）。`,
      `题目来源：${v('source')}`,
      `版式：${v('layout')}`,
      `题目数量：${v('count')} 道`,
      '',
      '输出结构：',
      '1. 卡头：标题、班级 / 姓名 / 日期填写栏。',
      '2. 题目区：按选定版式排布，每题标注分值与难度。',
      '3. 答案区：独立区块，打印时可选隐藏。',
      '4. 页脚：「导出图片」按钮，打印样式隐藏按钮与页边距。',
      '',
      '要求：单文件自包含，内联 CSS，无外链、无网络请求；字体用系统字体栈（PingFang SC / Microsoft YaHei 回退），不引 webfont。',
    ].join('\n')
  }
  if (tool === 'advice') {
    return [
      `请使用 skill「${skill}」给出教学建议，按 Markdown 输出。`,
      `班级情况：${v('class_name')}`,
      `单元 / 课题：${v('unit')}`,
      `关注点：${v('focus')}`,
      '',
      '输出结构（按此顺序）：',
      '1. 学情判断：结合给出的班级情况，指出 2–3 个可验证的课堂事实。',
      '2. 课堂策略：导入、主要活动、分层任务各给一条可执行方案，标注时长。',
      '3. 评价与作业：课堂即时评价方式，配套作业与批改口径。',
      '4. 风险点：2–3 条，每条附应对办法。',
      '',
      '建议要具体到教师能照做；不要泛泛谈教育理念。',
    ].join('\n')
  }
  return [
    `请使用 skill「${skill}」生成学期教学计划，按 Markdown 表格输出。`,
    `学期：${v('term')}`,
    `单元范围：${v('scope')}`,
    `周数：${v('weeks')} 周`,
    '',
    '输出结构：',
    '1. 一张表格：周次 / 单元 / 课题 / 课时 / 教学目标 / 评价方式。',
    '2. 表格下方给出课时合计，与周数匹配，并注明期中、期末复习周。',
    '3. 表格可直接打印；不要拆成多张表。',
  ].join('\n')
}

const Field: React.FC<{
  field: FieldDef
  value: string
  onChange: (name: string, value: string) => void
}> = ({ field, value, onChange }) => (
  <label className="twb-field">
    <span>{t(field.labelKey)}</span>
    {field.type === 'textarea' ? (
      <textarea
        className="twb-textarea"
        rows={3}
        value={value}
        placeholder={field.placeholder}
        required={field.required}
        onChange={(e) => onChange(field.name, e.target.value)}
      />
    ) : field.type === 'select' ? (
      <select className="twb-select" value={value} onChange={(e) => onChange(field.name, e.target.value)}>
        {(field.choices || []).map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        className="twb-input"
        type={field.type}
        value={value}
        placeholder={field.placeholder}
        required={field.required}
        min={field.min}
        max={field.max}
        onChange={(e) => onChange(field.name, e.target.value)}
      />
    )}
  </label>
)

const TeachingPage: React.FC = () => {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  // Both deep-link shapes reach the same tool: `?tool=card` from the rail and
  // home cards, `/teaching/card` from a saved link.
  const fromPath = asToolId(location.pathname.replace(/^\/teaching\/?/, '').split('/')[0] || '')
  const urlTool = asToolId(searchParams.get('tool') || '') || fromPath
  const [tool, setTool] = useState<ToolId>(urlTool || TOOL_IDS[0])
  const [values, setValues] = useState<Record<ToolId, Record<string, string>>>(defaultValues)
  const navigate = useNavigate()
  const sessionId = `teach-${tool}`
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const running = useChatStore((s) => s.getSession(sessionId).isStreaming)

  // A link from the rail carries ?tool=<id>; follow it both when the page
  // mounts and when the parameter changes underneath it. Dropping the parameter
  // (the parent 教学工具 entry) returns to the first tool.
  useEffect(() => {
    const next = urlTool || TOOL_IDS[0]
    setTool((current) => (current === next ? current : next))
  }, [urlTool])

  const active = TOOLS.find((item) => item.id === tool) || TOOLS[0]
  const activeValues = values[tool]
  const rows = useMemo(() => rowsOf(active.fields), [active])
  // Live, so the teacher reads exactly what will be sent before pressing it.
  const preview = buildPrompt(tool, active.skill, activeValues)

  const setField = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [tool]: { ...prev[tool], [name]: value } }))
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const prompt = preview.trim()
    // A double click can land before the stream state rerenders.
    if (!prompt || useChatStore.getState().sessions[sessionId]?.isStreaming) return
    void send(sessionId, prompt, [])
  }

  /** The same conversation, opened where it lives in full. */
  const openFullSession = async () => {
    await useSessionStore.getState().setActive(sessionId)
    // An open editor can refuse the switch; stay here rather than landing on
    // whatever conversation the rail still has selected.
    if (useSessionStore.getState().activeId === sessionId) navigate('/')
  }

  return (
    <div id="twb-teaching" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head">
            <div>
              <span className="twb-eyebrow">{t('tw_teach_title')}</span>
              <h1>{t(active.labelKey)}</h1>
              <p>{t(active.descKey)}</p>
            </div>
          </header>

          <div className="twb-teach-grid">
            <form className="twb-card twb-form" onSubmit={submit}>
              <div className="twb-card-head">
                <h2>{t('tw_teach_form')}</h2>
                <span className="twb-count">{active.skill}</span>
              </div>
              {rows.map((row) =>
                row.length === 2 ? (
                  <div className="twb-field-row" key={row[0].name}>
                    {row.map((field) => (
                      <Field key={field.name} field={field} value={activeValues[field.name]} onChange={setField} />
                    ))}
                  </div>
                ) : (
                  <Field
                    key={row[0].name}
                    field={row[0]}
                    value={activeValues[row[0].name]}
                    onChange={setField}
                  />
                )
              )}
              <div className="twb-form-actions">
                {running ? (
                  <button type="button" className="twb-btn" onClick={() => void cancel(sessionId)}>
                    <Square size={14} />
                    <span>{t('tw_teach_stop')}</span>
                  </button>
                ) : (
                  <button type="submit" className="twb-btn twb-btn-primary">
                    <Sparkles size={15} />
                    <span>{t('tw_teach_generate')}</span>
                  </button>
                )}
                <span className="twb-hint">{t('tw_teach_submit_hint')}</span>
              </div>
            </form>

            <section className="twb-card twb-teach-out" aria-labelledby="twb-teach-session">
              <div className="twb-card-head">
                <h2 id="twb-teach-session">{t('tw_teach_session')}</h2>
                <button type="button" className="twb-link" onClick={() => void openFullSession()}>
                  <ExternalLink size={13} />
                  <span>{t('tw_teach_open_chat')}</span>
                </button>
              </div>
              <div className="twb-teach-out-body">
                <EmbeddedChat sessionId={sessionId} />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

export default TeachingPage
