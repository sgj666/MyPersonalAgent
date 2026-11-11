import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  CalendarDays,
  Copy,
  FileText,
  Lightbulb,
  Presentation,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { t } from '../i18n'
import { startNewChat } from '../lib/newChat'
import { prefillChatInput } from '../store/draftStore'
import { guardDocEditors } from '../store/docEditorStore'
import { useWorkspaceStore } from '../store/workspaceStore'

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
  icon: LucideIcon
  fields: FieldDef[]
}

const choices = (...values: string[]): Choice[] => values.map((value) => ({ value, label: value }))

/**
 * The five forms, transcribed from the web console
 * (channel/web/static/js/views/teaching.js). Choice values are the Chinese the
 * prompt quotes, so the preview shows exactly what the Agent will read.
 */
const TOOLS: ToolDef[] = [
  {
    id: 'plan',
    labelKey: 'tw_tool_plan',
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
 * The Chinese request each form turns into. Kept line-for-line with the web
 * console's twTeachBuildPrompt so the same tool produces the same prompt in
 * both clients; an empty field reads 未填写 rather than dropping its line.
 */
function buildPrompt(tool: ToolId, values: Record<string, string>): string {
  const v = (key: string) => (values[key] ? values[key].trim() : '未填写')
  if (tool === 'plan') {
    return [
      '请生成一份教案（Markdown 输出）。',
      `学段：${v('stage')}`,
      `学科：${v('subject')}`,
      `教材版本：${v('book')}`,
      `单元 / 课题：${v('unit')}`,
      `课型：${v('lesson_type')}`,
      `课时：${v('hours')} 课时`,
      `教学目标：${v('goal')}`,
      '',
      '要求：',
      '1. 按「教学目标 / 教学重难点 / 教学准备 / 教学过程（分环节并标注时间）/ 板书设计 / 作业布置 / 课后反思」组织。',
      '2. 教学过程写出教师活动、学生活动和设计意图。',
      '3. 语言面向教师，可直接照着上课；引用教材内容请注明出处。',
      '4. 生成后保存到知识库的「教案」分类。',
    ].join('\n')
  }
  if (tool === 'courseware') {
    return [
      '请生成一套课件（.pptx）。',
      `单元 / 课题：${v('unit')}`,
      `教案来源：${v('source')}`,
      `母版模板：${v('template')}`,
      `页数：约 ${v('slides')} 页`,
      '',
      '要求：',
      '1. 先生成结构化内容：封面、目录、每页标题 + 要点 + 备注稿。',
      `2. 使用「${v('template')}」母版；只用主题字体，不嵌字体，避免跨机版式错乱。`,
      '3. 输出真实 .pptx 文件到产出目录，完成后告诉我文件路径。',
    ].join('\n')
  }
  if (tool === 'card') {
    return [
      '请生成一份作业卡片（单文件 HTML）。',
      `题目来源：${v('source')}`,
      `版式：${v('layout')}`,
      `题目数量：${v('count')} 道`,
      '',
      '要求：',
      '1. 单文件自包含：内联 CSS，无外链、无网络请求，便于在产出视图内嵌预览。',
      '2. 页面内提供「导出图片」，打印样式隐藏按钮与页边距。',
      '3. 字体使用系统字体栈（PingFang SC / Microsoft YaHei 回退），不引 webfont。',
      '4. 生成后保存到产出目录的「作业卡片」分类。',
    ].join('\n')
  }
  if (tool === 'advice') {
    return [
      '请给出教学建议。',
      `班级情况：${v('class_name')}`,
      `单元 / 课题：${v('unit')}`,
      `关注点：${v('focus')}`,
      '',
      '要求：结合学情给出可执行的课堂策略（导入、活动、分层任务、评价与作业），并指出 2–3 个需要提前准备的风险点。',
    ].join('\n')
  }
  return [
    '请生成学期教学计划（Markdown 表格）。',
    `学期：${v('term')}`,
    `单元范围：${v('scope')}`,
    `周数：${v('weeks')} 周`,
    '',
    '要求：',
    '1. 表格列：周次 / 单元 / 课题 / 课时 / 教学目标 / 评价方式。',
    '2. 课时总量与周数匹配，注明期中、期末复习周。',
    '3. 表格可直接打印。',
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
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const fromUrl = searchParams.get('tool') || ''
  const [tool, setTool] = useState<ToolId>(
    TOOL_IDS.includes(fromUrl as ToolId) ? (fromUrl as ToolId) : 'plan'
  )
  const [values, setValues] = useState<Record<ToolId, Record<string, string>>>(defaultValues)
  const [status, setStatus] = useState('')

  // A link from the rail or the home cards carries ?tool=<id>; follow it both
  // when the page mounts and when the parameter changes underneath it.
  // Dropping the parameter (the parent 教学工具 entry) returns to the first tool.
  const urlTool = TOOL_IDS.includes(fromUrl as ToolId) ? (fromUrl as ToolId) : null
  useEffect(() => {
    const next = urlTool || TOOL_IDS[0]
    setTool((current) => (current === next ? current : next))
  }, [urlTool])

  const active = TOOLS.find((item) => item.id === tool) || TOOLS[0]
  const activeValues = values[tool]
  const rows = useMemo(() => rowsOf(active.fields), [active])
  // Live, so the teacher reads exactly what will be sent before pressing it.
  const preview = buildPrompt(tool, activeValues)

  const selectTool = (id: ToolId) => {
    setTool(id)
    setStatus('')
    const next = new URLSearchParams(searchParams)
    next.set('tool', id)
    setSearchParams(next, { replace: true })
  }

  const setField = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [tool]: { ...prev[tool], [name]: value } }))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const prompt = preview.trim()
    if (!prompt) return
    // Navigating away must not throw away unsaved work in a document or a
    // workspace editor, the same guard every other "open the chat" entry uses.
    if (!(await guardDocEditors())) {
      setStatus(t('tw_teach_leave_blocked'))
      return
    }
    if (!(await useWorkspaceStore.getState().guardUnsavedEdit())) return
    setStatus('')
    startNewChat()
    prefillChatInput(prompt)
    navigate('/')
  }

  return (
    <div id="twb-teaching" className="flex-1 flex flex-col min-h-0">
      <div className="twb-scroll">
        <div className="twb-page">
          <header className="twb-page-head">
            <div>
              <h1>{t('tw_teach_title')}</h1>
              <p>{t('tw_teach_desc')}</p>
            </div>
          </header>

          <div className="twb-segs" role="tablist" aria-label={t('tw_teach_title')}>
            {TOOLS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  id={`twb-teach-tab-${item.id}`}
                  role="tab"
                  className="twb-seg"
                  aria-selected={item.id === tool}
                  aria-controls={`twb-teach-panel-${item.id}`}
                  onClick={() => selectTool(item.id)}
                >
                  <Icon size={14} />
                  <span>{t(item.labelKey)}</span>
                </button>
              )
            })}
          </div>

          <div className="twb-teach-grid">
            <form
              className="twb-card twb-form"
              id={`twb-teach-panel-${active.id}`}
              role="tabpanel"
              aria-labelledby={`twb-teach-tab-${active.id}`}
              onSubmit={submit}
            >
              <h2>{t(active.labelKey)}</h2>
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
                <button type="submit" className="twb-btn twb-btn-primary">
                  <Sparkles size={15} />
                  <span>{t('tw_teach_generate')}</span>
                </button>
                <span className="twb-hint">{t('tw_teach_submit_hint')}</span>
              </div>
            </form>

            <aside className="twb-card twb-teach-aside" aria-labelledby="twb-teach-preview">
              <div className="twb-card-head">
                <h2 id="twb-teach-preview">{t('tw_teach_preview')}</h2>
              </div>
              <textarea className="twb-textarea twb-preview" readOnly rows={16} value={preview} />
              <p className="twb-hint">{t('tw_teach_preview_hint')}</p>
              <p className="twb-status is-error" role="status">
                {status}
              </p>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

export default TeachingPage
