import React from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { asToolId, TOOL_IDS, type ToolId } from './teaching/drafts'
import PlanTool from './teaching/PlanTool'
import CoursewareTool from './teaching/CoursewareTool'
import CardTool from './teaching/CardTool'
import AdviceTool from './teaching/AdviceTool'
import ScheduleTool from './teaching/ScheduleTool'

/**
 * Five pages, each laid out for what it produces
 * (docs/plans/teaching-tools-redesign.md §3): 教案 = manuscript, 课件 = slide
 * rail + preview + notes, 作业卡片 = portrait card, 教学建议 = facts +
 * actions, 教学计划 = week table.
 */
const TOOL_PAGES: Record<ToolId, React.FC> = {
  plan: PlanTool,
  courseware: CoursewareTool,
  card: CardTool,
  advice: AdviceTool,
  schedule: ScheduleTool,
}

const TeachingPage: React.FC = () => {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  // Both deep-link shapes reach the same tool: `?tool=card` from the rail and
  // home cards, `/teaching/card` from a saved link. No tool → the first one.
  const fromPath = asToolId(location.pathname.replace(/^\/teaching\/?/, '').split('/')[0] || '')
  const tool = asToolId(searchParams.get('tool') || '') || fromPath || TOOL_IDS[0]
  const Page = TOOL_PAGES[tool]

  return (
    <div id="twb-teaching" className="flex-1 flex flex-col min-h-0">
      {/* Keyed by tool so switching tools starts from that tool's own state. */}
      <Page key={tool} />
    </div>
  )
}

export default TeachingPage
