// The nav rail's menu: the built-in one, or the one the user arranged
// (GET /api/menu). The web console reads the same document, so a page only
// one client has is skipped by the other, never dropped. Mirrors the web
// console's core/menu.js.
import {
  MessageSquare,
  Users,
  BookOpen,
  Brain,
  Zap,
  Radio,
  Clock,
  Settings,
  ScrollText,
  Globe,
  Link,
  ChartLine,
  Gauge,
  Table,
  FileText,
  Book,
  Image,
  Film,
  Music,
  Code,
  Calendar,
  Star,
  Bookmark,
  Folder,
  Box,
  Rocket,
  ClipboardList,
  GraduationCap,
  ListChecks,
  CalendarDays,
  NotebookPen,
  Flag,
  Heart,
  Terminal,
  House,
  KanbanSquare,
  PencilRuler,
  ShoppingCart,
  Mail,
  Layers,
  Bot,
  Pen,
  Search,
  Presentation,
  Copy,
  Lightbulb,
  type LucideIcon,
} from 'lucide-react'
import { t } from '../i18n'
import { iconFor } from './fileKind'
import type { FileKind, MenuChild, MenuDoc, MenuGroup, MenuItem } from '../types'

/** The pages of this app a menu can lead to, by the view name the document uses. */
export const MENU_BUILTINS: Record<string, { path: string; labelKey: string; icon: LucideIcon }> = {
  home: { path: '/home', labelKey: 'menu_home', icon: House },
  classes: { path: '/classes', labelKey: 'menu_classes', icon: Users },
  timetable: { path: '/timetable', labelKey: 'menu_timetable', icon: CalendarDays },
  progress: { path: '/progress', labelKey: 'menu_progress', icon: ListChecks },
  homework: { path: '/homework', labelKey: 'menu_homework', icon: ClipboardList },
  scores: { path: '/scores', labelKey: 'menu_scores', icon: GraduationCap },
  board: { path: '/board', labelKey: 'menu_board', icon: KanbanSquare },
  teaching: { path: '/teaching', labelKey: 'menu_teaching', icon: PencilRuler },
  chat: { path: '/', labelKey: 'menu_chat', icon: MessageSquare },
  artifacts: { path: '/artifacts', labelKey: 'menu_artifacts', icon: Layers },
  agents: { path: '/agents', labelKey: 'menu_agents', icon: Users },
  knowledge: { path: '/knowledge', labelKey: 'menu_knowledge', icon: BookOpen },
  memory: { path: '/memory', labelKey: 'menu_memory', icon: Brain },
  skills: { path: '/skills', labelKey: 'menu_skills', icon: Zap },
  channels: { path: '/channels', labelKey: 'menu_channels', icon: Radio },
  tasks: { path: '/tasks', labelKey: 'menu_tasks', icon: Clock },
  config: { path: '/settings', labelKey: 'menu_settings', icon: Settings },
  logs: { path: '/logs', labelKey: 'menu_logs', icon: ScrollText },
}

/** One tool of the teaching page, as the rail draws it. */
export interface MenuTeachingTool {
  tab: string
  labelKey: string
  icon: LucideIcon
}

// The tools nested under 教学工具, in the order the rail and the page show
// them. Labels are the page's own (tw_tool_*), so the tab and the rail agree;
// icons come from the same family as the page's tabs.
export const MENU_TEACHING_TOOLS: MenuTeachingTool[] = [
  { tab: 'plan', labelKey: 'tw_tool_plan', icon: FileText },
  { tab: 'courseware', labelKey: 'tw_tool_courseware', icon: Presentation },
  { tab: 'card', labelKey: 'tw_tool_card', icon: Copy },
  { tab: 'advice', labelKey: 'tw_tool_advice', icon: Lightbulb },
  { tab: 'schedule', labelKey: 'tw_tool_schedule', icon: CalendarDays },
]

/** A branch draws at most this many children; mirrors MAX_CHILDREN in channel/web/api/menu.py. */
export const MENU_CHILDREN_MAX = 8

export function teachingTool(tab: string): MenuTeachingTool | undefined {
  return MENU_TEACHING_TOOLS.find((tool) => tool.tab === tab)
}

/** The five tools as nested entries of the 教学工具 page. */
export function defaultTeachingChildren(): MenuChild[] {
  return MENU_TEACHING_TOOLS.slice(0, MENU_CHILDREN_MAX).map((tool) => ({ view: 'teaching', tab: tool.tab }))
}

// The built-in menu, drawn in these groups until the user saves their own.
// The document is shared with the web console, so it keeps every page the
// console has, footer ones included.
//
// docs/plans/teacher-academics.md §1: 对话 → 教学 → 管理 → 监控, each group
// open (no folding); a group lists its pages 日常高频 → 低频.
export const MENU_DEFAULT: { id: string; views: string[] }[] = [
  { id: 'chat', views: ['chat', 'artifacts'] },
  {
    id: 'teach',
    views: ['home', 'classes', 'timetable', 'progress', 'homework', 'scores', 'teaching', 'board', 'knowledge'],
  },
  { id: 'manage', views: ['agents', 'config', 'skills', 'memory', 'channels', 'tasks'] },
  { id: 'monitor', views: ['logs'] },
]

export const MENU_GROUP_LABELS: Record<string, string> = {
  teach: 'nav_teach',
  chat: 'nav_chat',
  manage: 'nav_manage',
  monitor: 'nav_monitor',
}

/** Pages a menu must always lead to; mirrors REQUIRED_VIEWS in channel/web/api/menu.py. */
export const MENU_REQUIRED = new Set(['chat', 'config'])

/** Artifacts that can be a page of the menu; mirrors MENU_KINDS in channel/web/api/menu.py. */
export const MENU_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['html', 'markdown'])

/** Pages the built-in menu carries: they can be hidden, never removed. */
export const MENU_DEFAULT_VIEWS = new Set(MENU_DEFAULT.flatMap((g) => g.views))

/**
 * Pages this app keeps in the rail's footer menu rather than in the menu. The
 * entry stays in the document, untouched, for the web console; here neither
 * the rail nor the editor shows it.
 */
const MENU_FOOTER_VIEWS: ReadonlySet<string> = new Set(['logs'])

export function isFooterItem(item: MenuItem): boolean {
  return item.type === 'builtin' && MENU_FOOTER_VIEWS.has(item.view || '')
}

// Icons a user can give an entry. Only the names travel in the document; the
// web console maps the same names to its own icon set.
export const MENU_ICONS: Record<string, LucideIcon> = {
  globe: Globe,
  link: Link,
  chart: ChartLine,
  gauge: Gauge,
  table: Table,
  file: FileText,
  book: Book,
  image: Image,
  video: Film,
  music: Music,
  code: Code,
  calendar: Calendar,
  star: Star,
  bookmark: Bookmark,
  folder: Folder,
  box: Box,
  rocket: Rocket,
  flag: Flag,
  heart: Heart,
  bolt: Zap,
  brain: Brain,
  clock: Clock,
  terminal: Terminal,
  home: House,
  cart: ShoppingCart,
  mail: Mail,
  layers: Layers,
  robot: Bot,
  pen: Pen,
  search: Search,
}

export const MENU_TITLE_MAX = 40

export function builtinItem(view: string): MenuItem {
  return { id: view, type: 'builtin', view, title: '', icon: '', hidden: false }
}

/** The children a page draws: the document's own, or the built-in set when it has none. */
function withChildren(item: MenuItem): MenuItem {
  if (item.type !== 'builtin' || item.view !== 'teaching') return item
  // A tab this client has no form for is kept, not dropped: the page falls
  // back to its first tool, the same way it does for a web-console-only page.
  const saved = (item.children || [])
    .filter((child) => !!child && child.view === 'teaching' && !!child.tab)
    .slice(0, MENU_CHILDREN_MAX)
  return { ...item, children: saved.length ? saved : defaultTeachingChildren() }
}

/** The nested entries an item draws: what the document carries, else the built-in set. */
export function itemChildren(item: MenuItem): MenuChild[] {
  return withChildren(item).children || []
}

export function childLabel(child: MenuChild): string {
  if (child.title) return child.title
  const tool = teachingTool(child.tab)
  return tool ? t(tool.labelKey) : child.tab
}

export function childIcon(child: MenuChild): LucideIcon {
  return teachingTool(child.tab)?.icon || Folder
}

/** The built-in menu as a document. */
export function defaultMenu(): MenuDoc {
  return {
    groups: MENU_DEFAULT.map((g) => ({ id: g.id, title: '', items: g.views.map((v) => withChildren(builtinItem(v))) })),
  }
}

/** The menu to draw: the saved one, plus any built-in page this version added since. */
export function mergeMenu(saved: MenuDoc | null): MenuDoc {
  if (!saved || !Array.isArray(saved.groups) || !saved.groups.length) return defaultMenu()
  const doc: MenuDoc = {
    groups: saved.groups.map((g) => ({
      id: g.id,
      title: g.title || '',
      items: (g.items || []).map((i) => withChildren({ ...i })),
    })),
  }
  const present = new Set<string>()
  doc.groups.forEach((g) => g.items.forEach((i) => i.type === 'builtin' && i.view && present.add(i.view)))
  for (const def of MENU_DEFAULT) {
    for (const view of def.views) {
      if (present.has(view)) continue
      const home = doc.groups.find((g) => g.id === def.id) || doc.groups[doc.groups.length - 1]
      home.items.push(withChildren(builtinItem(view)))
    }
  }
  return doc
}

export function findItem(doc: MenuDoc, id: string): { group: MenuGroup; item: MenuItem } | null {
  for (const group of doc.groups) {
    const item = group.items.find((i) => i.id === id)
    if (item) return { group, item }
  }
  return null
}

export function groupLabel(group: MenuGroup): string {
  if (group.title) return group.title
  return MENU_GROUP_LABELS[group.id] ? t(MENU_GROUP_LABELS[group.id]) : t('menu_group_untitled')
}

export function itemLabel(item: MenuItem): string {
  if (item.title) return item.title
  if (item.type !== 'builtin' || !item.view) return ''
  const builtin = MENU_BUILTINS[item.view]
  if (builtin) return t(builtin.labelKey)
  // A page only the web console has, named if this app knows what it is.
  const key = `menu_${item.view}`
  return t(key) === key ? item.view : t(key)
}

export function itemIcon(item: MenuItem): LucideIcon {
  if (item.icon && MENU_ICONS[item.icon]) return MENU_ICONS[item.icon]
  if (item.type === 'builtin') return (item.view && MENU_BUILTINS[item.view]?.icon) || Folder
  if (item.type === 'url') return Globe
  return iconFor(item.file?.kind || 'file')
}

/** Whether the rail draws the entry: hidden pages, footer pages and pages only the web console has are skipped. */
export function itemShows(item: MenuItem): boolean {
  if (item.type !== 'builtin') return true
  return !!item.view && !!MENU_BUILTINS[item.view] && !item.hidden && !isFooterItem(item)
}

/** Where a built-in page leads; a teaching tool adds its `?tool=` selection. */
export function viewRoute(view: string, tab?: string): string {
  const path = MENU_BUILTINS[view]?.path || '/'
  return view === 'teaching' && tab ? `${path}?tool=${encodeURIComponent(tab)}` : path
}

/** Where an entry leads inside the app; `tab` overrides the item's own tool. */
export function itemRoute(item: MenuItem, tab?: string): string {
  if (item.type === 'builtin') return item.view ? viewRoute(item.view, tab ?? item.tab) : '/'
  return `/m/${encodeURIComponent(item.id)}`
}

/**
 * Whether the rail lights this entry. A child needs both its page and its
 * tool; the parent stays lit only while no child owns the current tool.
 */
export function isItemActive(item: MenuItem, pathname: string, search: string): boolean {
  if (item.type !== 'builtin') return pathname === itemRoute(item)
  if (!item.view || !MENU_BUILTINS[item.view]) return false
  const path = MENU_BUILTINS[item.view].path
  if (pathname !== path) return false
  if (item.view !== 'teaching') return true
  const tool = new URLSearchParams(search).get('tool')
  if (item.tab) return tool === item.tab
  return !itemChildren(item).some((child) => child.tab === tool)
}

export function newMenuId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10)
}
