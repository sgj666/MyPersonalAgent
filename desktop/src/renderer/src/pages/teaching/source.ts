// Where the tool pages read from: the real API by default, or the
// illustrative demo set when the URL carries `?demo=` (screenshots and visual
// review only). Demo variants: `1` data, `empty` no data, `loading` never
// answers, `error` every call fails the way a missing endpoint does.
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import apiClient from '../../api/client'
import type {
  TeachingDraftKind,
  TeachingFacts,
  TeachingProgressImport,
  TeachingRecentItem,
  TeachingRenderRequest,
  TeachingRenderResult,
  TeachingWeek,
} from '../../api/client'
import type {
  BoardTaskFields,
  HomeworkFields,
  KnowledgeList,
  ProgressItem,
  TeacherProfile,
  TeachingClass,
  TeachingTimetable,
} from '../../types'
import * as demo from '../../components/teaching/demoData'
import type { CardDraft, DeckDraft } from './drafts'

export type DemoMode = '1' | 'empty' | 'loading' | 'error'

export interface PreviewResult {
  /** The rendered HTML, ready for an iframe's srcdoc. */
  html: string
  /** Absolute path of the HTML file on disk; empty in demo mode. */
  path: string
  warnings: string[]
}

export interface TeachingSource {
  demo: DemoMode | null
  classes: () => Promise<TeachingClass[]>
  knowledge: () => Promise<KnowledgeList>
  recent: (kind: TeachingDraftKind) => Promise<TeachingRecentItem[]>
  facts: (classId: string, unit: string) => Promise<TeachingFacts>
  profile: () => Promise<Partial<TeacherProfile>>
  timetable: () => Promise<TeachingTimetable>
  progress: (classId: string) => Promise<ProgressItem[]>
  render: (req: TeachingRenderRequest) => Promise<TeachingRenderResult>
  /**
   * Render to HTML and read it back. `answer` (the card's answer copy) has no
   * field in the §4.1 render request, so the real source refuses it with
   * ANSWER_UNSUPPORTED instead of showing the student copy under that label.
   */
  preview: (kind: 'deck' | 'card', draft: DeckDraft | CardDraft, opts?: { a4?: boolean; answer?: boolean }) => Promise<PreviewResult>
  saveDraft: (kind: TeachingDraftKind, slug: string, draft: unknown) => Promise<string>
  importProgress: (classIds: string[], weeks: TeachingWeek[]) => Promise<TeachingProgressImport>
  /** Write a knowledge page; `overwrite` false refuses an existing file. */
  saveKnowledge: (path: string, content: string, overwrite: boolean) => Promise<void>
  createHomework: (fields: HomeworkFields) => Promise<void>
  createTask: (fields: BoardTaskFields) => Promise<void>
}

/** The error message the real source answers an answer-copy preview with. */
export const ANSWER_UNSUPPORTED = 'answer-unsupported'

const EMPTY_KNOWLEDGE: KnowledgeList = { tree: [], stats: { pages: 0, size: 0 }, enabled: true }

/** Fetch a rendered HTML file's text through the backend's file endpoint. */
async function readRendered(path: string): Promise<string> {
  const res = await fetch(apiClient.getServeFileUrl(path))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  return res.text()
}

const real: TeachingSource = {
  demo: null,
  classes: () => apiClient.listTeachingClasses(),
  knowledge: () => apiClient.getKnowledgeList(),
  recent: (kind) => apiClient.listTeachingRecent({ kind, limit: 5 }),
  facts: (classId, unit) => apiClient.getTeachingFacts({ class_id: classId, unit }),
  profile: () => apiClient.getTeachingProfile(),
  timetable: () => apiClient.getTeachingTimetable(),
  progress: (classId) => apiClient.listTeachingProgress(classId),
  render: (req) => apiClient.renderTeachingDraft(req),
  preview: async (kind, draft, opts = {}) => {
    if (opts.answer) throw new Error(ANSWER_UNSUPPORTED)
    const a4 = opts.a4 === true
    const format = a4 ? 'a4' : 'html'
    const result = await apiClient.renderTeachingDraft({ kind, draft, formats: [format] })
    const file = result.files.find((f) => f.format === format) || result.files[0]
    if (!file) throw new Error('render returned no file')
    return { html: await readRendered(file.path), path: file.path, warnings: result.warnings }
  },
  saveDraft: (kind, slug, draft) => apiClient.saveTeachingDraft(kind, slug, draft),
  importProgress: (classIds, weeks) => apiClient.importTeachingProgress(classIds, weeks),
  saveKnowledge: async (path, content, overwrite) => {
    const res = await apiClient.knowledgeAction({ action: 'create_document', payload: { path, content, overwrite } })
    if (res.status !== 'success') throw new Error(String(res.message || res.status))
  },
  createHomework: (fields) => apiClient.createTeachingHomework(fields),
  createTask: async (fields) => {
    await apiClient.createBoardTask(fields)
  },
}

function demoSource(mode: DemoMode): TeachingSource {
  const answer = <T,>(full: T, empty: T): (() => Promise<T>) => {
    if (mode === 'loading') return () => new Promise<T>(() => undefined)
    if (mode === 'error') return () => Promise.reject(new Error('HTTP 404: Not Found'))
    return () => Promise.resolve(mode === 'empty' ? empty : full)
  }
  return {
    demo: mode,
    classes: answer(demo.DEMO_CLASSES, demo.DEMO_CLASSES),
    knowledge: answer(demo.DEMO_KNOWLEDGE, EMPTY_KNOWLEDGE),
    recent: answer(demo.DEMO_RECENT, []),
    facts: answer(demo.DEMO_FACTS, { facts: [], stats: {} }),
    profile: answer({ subjects: ['英语'], textbook: '人教新版' }, {}),
    timetable: answer(demo.DEMO_TIMETABLE, { periods: [], slots: [], overrides: [] }),
    progress: answer(demo.DEMO_PROGRESS, []),
    render: answer({ files: [], warnings: [] }, { files: [], warnings: [] }),
    preview: (kind, draft, opts = {}) => {
      if (mode === 'loading') return new Promise<PreviewResult>(() => undefined)
      if (mode === 'error') return Promise.reject(new Error('HTTP 404: Not Found'))
      const html = kind === 'deck' ? demo.demoDeckHtml(draft as DeckDraft) : demo.demoCardHtml(draft as CardDraft, opts.answer === true)
      return Promise.resolve({ html, path: '', warnings: [] })
    },
    saveDraft: answer('artifacts/教学工具/demo.json', ''),
    importProgress: answer({ created: 6, skipped: 1, conflicts: [] }, { created: 0, skipped: 0, conflicts: [] }),
    saveKnowledge: answer(undefined, undefined),
    createHomework: answer(undefined, undefined),
    createTask: answer(undefined, undefined),
  }
}

const DEMO_MODES: DemoMode[] = ['1', 'empty', 'loading', 'error']

export function useTeachingSource(): TeachingSource {
  const [params] = useSearchParams()
  const raw = params.get('demo') || ''
  const mode = DEMO_MODES.includes(raw as DemoMode) ? (raw as DemoMode) : null
  return useMemo(() => (mode ? demoSource(mode) : real), [mode])
}
