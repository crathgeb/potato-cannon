import { Link, useLocation } from '@tanstack/react-router'
import { LayoutDashboard, Layers, SlidersHorizontal, GitCommitVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// thread-viz only has a real target wired up for the homesflow project today
// (targets/homesflow.yaml in that repo) — gate the tab on slug so it doesn't
// show a dead link on projects it has never scanned.
const THREAD_VIZ_URL = 'http://127.0.0.1:5177'
const THREAD_VIZ_PROJECT_SLUG = 'homesflow'

export function ViewTabs() {
  const location = useLocation()

  // Extract projectId from URL
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/)
  const projectId = projectMatch ? decodeURIComponent(projectMatch[1]) : null

  if (!projectId) return null // Don't show tabs if not on a project route

  const isBoardActive = location.pathname.endsWith('/board')
  const isEpicsActive = location.pathname.endsWith('/epics')
  const isConfigureActive = location.pathname.endsWith('/configure')
  const showThreadViz = projectId === THREAD_VIZ_PROJECT_SLUG

  return (
    <nav className="hidden sm:flex flex-1 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/projects/$projectId/epics"
            params={{ projectId }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              isEpicsActive
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            )}
          >
            <Layers className="h-4 w-4" />
            <span>Epics</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent>Group related tickets into epics</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/projects/$projectId/board"
            params={{ projectId }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              isBoardActive
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            )}
          >
            <LayoutDashboard className="h-4 w-4" />
            <span>Board</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent>An AI Assisted Kanban board</TooltipContent>
      </Tooltip>
      {showThreadViz && (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={THREAD_VIZ_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            >
              <GitCommitVertical className="h-4 w-4" />
              <span>Thread Viz</span>
            </a>
          </TooltipTrigger>
          <TooltipContent>Open the coverage matrix explorer (opens in a new tab)</TooltipContent>
        </Tooltip>
      )}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/projects/$projectId/configure"
            params={{ projectId }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              isConfigureActive
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span>Configure</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent>Configure Project</TooltipContent>
      </Tooltip>
    </nav>
  )
}
