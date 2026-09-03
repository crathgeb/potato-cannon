import { useState, useMemo, useCallback, useRef } from 'react'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  useTickets,
  useProjectPhases,
  useTemplate,
  useUpdateTicket,
  useProjects,
  useToggleAutomatedPhase,
  useUpdateProject
} from '@/hooks/queries'
import { handleVerticalToHorizontalScroll } from '@/lib/scroll-translation'
import { TemplateUpgradeBanner } from '@/components/TemplateUpgradeBanner'
import { ArchivedSwimlane } from './ArchivedSwimlane'
import { BoardColumn } from './BoardColumn'
import { TicketCard } from './TicketCard'
import { ViewToggle } from './ViewToggle'
import { TableView } from './TableView'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { Ticket, TemplatePhase } from '@potato-cannon/shared'

/**
 * Checks if a phase has automation configured (agents, ralphLoop, or ticketLoop)
 */
function phaseHasAutomation(phaseConfig: TemplatePhase | undefined): boolean {
  if (!phaseConfig) return false
  return !!(
    (phaseConfig.agents && phaseConfig.agents.length > 0) ||
    phaseConfig.ralphLoop ||
    phaseConfig.ticketLoop
  )
}

/**
 * Checks if a phase can be automated (eligible for toggle).
 * A phase can be automated if it's either:
 * - A manual checkpoint (transitions.manual: true with no automation), or
 * - A phase with an answerBot worker
 * First and last phases cannot be automated.
 */
function canAutomate(
  phaseConfig: TemplatePhase | undefined,
  phaseName: string,
  allPhases: string[]
): boolean {
  // First and last phases cannot be automated
  if (allPhases.length > 0) {
    if (phaseName === allPhases[0] || phaseName === allPhases[allPhases.length - 1]) return false
  }

  if (!phaseConfig) return false

  // Manual checkpoint phases can be automated (pass through)
  if (phaseConfig.transitions?.manual && !phaseHasAutomation(phaseConfig)) {
    return true
  }

  // Phases with an answerBot can be automated
  if (phaseConfig.workers?.some(w => w.type === 'answerBot')) {
    return true
  }

  return false
}

interface BoardProps {
  projectId: string
}

export function Board({ projectId }: BoardProps) {
  // Queries
  const { data: projects } = useProjects()
  const { data: tickets, isLoading: ticketsLoading, error: ticketsError } = useTickets(projectId)
  const { data: phases } = useProjectPhases(projectId)

  // Get current project to access template name
  const currentProject = useMemo(
    () => projects?.find((p) => p.id === projectId),
    [projects, projectId]
  )

  const { data: templateConfig } = useTemplate(currentProject?.template?.name ?? null)

  // Mutations
  const updateTicket = useUpdateTicket()
  const toggleAutomatedPhase = useToggleAutomatedPhase()
  const updateProject = useUpdateProject()

  // View mode from store
  const boardViewMode = useAppStore((s) => s.boardViewMode)
  const showArchivedTickets = useAppStore((s) => s.showArchivedTickets)

  const handleToggleAutomated = useCallback(
    (phaseName: string) => {
      if (!currentProject) return

      const isCurrentlyAutomated = currentProject.automatedPhases?.includes(phaseName) ?? false

      toggleAutomatedPhase.mutate({
        projectId,
        phaseId: phaseName,
        automated: !isCurrentlyAutomated
      })
    },
    [projectId, currentProject, toggleAutomatedPhase]
  )

  const handleSwimlaneColorChange = useCallback(
    (phaseName: string, color: string | null) => {
      if (!currentProject) return

      const currentColors = currentProject.swimlaneColors || {}
      let newColors: Record<string, string>

      if (color === null) {
        // Remove the color for this phase
        const { [phaseName]: _, ...rest } = currentColors
        newColors = rest
      } else {
        // Set the color for this phase
        newColors = { ...currentColors, [phaseName]: color }
      }

      updateProject.mutate({
        id: projectId,
        updates: { swimlaneColors: newColors }
      })
    },
    [projectId, currentProject, updateProject]
  )

  const handleWipLimitChange = useCallback(
    (phaseName: string, limit: number | null) => {
      if (!currentProject) return

      const currentLimits = currentProject.wipLimits || {}
      let newLimits: Record<string, number>

      if (limit === null) {
        const { [phaseName]: _, ...rest } = currentLimits
        newLimits = rest
      } else {
        newLimits = { ...currentLimits, [phaseName]: limit }
      }

      updateProject.mutate({
        id: projectId,
        updates: {
          wipLimits: Object.keys(newLimits).length > 0 ? newLimits : null
        }
      })
    },
    [projectId, currentProject, updateProject]
  )

  // Sensors for drag and drop
  // PointerSensor: desktop mouse drag (5px movement before activating)
  // TouchSensor: mobile long-press drag (200ms delay to avoid conflict with scroll)
  // KeyboardSensor: keyboard accessibility (arrow keys + Enter)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5
      }
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5
      }
    }),
    useSensor(KeyboardSensor)
  )

  // Local state
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    ticketId: string
    targetPhase: string
    phaseName: string
  } | null>(null)
  const [wipOverrideDialog, setWipOverrideDialog] = useState<{
    open: boolean
    ticketId: string
    targetPhase: string
    phaseName: string
    hasAutomation: boolean
  } | null>(null)

  const scrollCleanupRef = useRef<(() => void) | null>(null)

  // Callback ref: attaches wheel listener when the board container mounts.
  // useEffect can miss this element because it's behind loading/error early returns;
  // a callback ref fires exactly when the element enters/leaves the DOM.
  const scrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    scrollCleanupRef.current?.()
    scrollCleanupRef.current = null

    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      handleVerticalToHorizontalScroll(e, el)
    }

    el.addEventListener('wheel', handleWheel, { passive: false })

    scrollCleanupRef.current = () => {
      el.removeEventListener('wheel', handleWheel)
    }
  }, [])

  // Group tickets by phase
  const ticketsByPhase = useMemo(() => {
    const grouped: Record<string, Ticket[]> = {}
    if (phases) {
      phases.forEach((phase) => {
        grouped[phase] = []
      })
    }
    if (tickets) {
      tickets.forEach((ticket) => {
        if (grouped[ticket.phase]) {
          grouped[ticket.phase].push(ticket)
        } else if (phases && !phases.includes(ticket.phase)) {
          // Ticket in unknown phase - add to first phase
          if (phases[0]) {
            grouped[phases[0]].push(ticket)
          }
        }
      })
    }
    return grouped
  }, [tickets, phases])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const ticket = event.active.data.current?.ticket as Ticket | undefined
    if (ticket) {
      setActiveTicket(ticket)
    }
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTicket(null)

      const { active, over } = event
      if (!over || !projectId) return

      const ticketId = active.id as string
      const ticket = active.data.current?.ticket as Ticket | undefined
      const targetPhase = over.id as string

      if (!ticket || ticket.phase === targetPhase) return

      // Check WIP limit
      const wipLimit = currentProject?.wipLimits?.[targetPhase]
      const phaseTickets = ticketsByPhase[targetPhase] || []
      const isAtWip = wipLimit !== undefined && phaseTickets.length >= wipLimit

      // Check if target phase has automation
      const phaseConfig = templateConfig?.phases.find((p) => p.name === targetPhase)
      const hasAutomation = phaseHasAutomation(phaseConfig)

      if (isAtWip) {
        // Show WIP override dialog
        setWipOverrideDialog({
          open: true,
          ticketId,
          targetPhase,
          phaseName: targetPhase,
          hasAutomation
        })
        return
      }

      if (hasAutomation) {
        // Show automation confirmation dialog
        setConfirmDialog({
          open: true,
          ticketId,
          targetPhase,
          phaseName: targetPhase
        })
      } else {
        // No automation and no WIP issue, move directly
        updateTicket.mutate({
          projectId,
          ticketId,
          updates: { phase: targetPhase }
        })
      }
    },
    [projectId, templateConfig, updateTicket, currentProject, ticketsByPhase]
  )

  const handleConfirmMove = useCallback(() => {
    if (!confirmDialog || !projectId) return

    updateTicket.mutate({
      projectId: projectId,
      ticketId: confirmDialog.ticketId,
      updates: { phase: confirmDialog.targetPhase }
    })

    setConfirmDialog(null)
  }, [confirmDialog, projectId, updateTicket])

  const handleCancelMove = useCallback(() => {
    setConfirmDialog(null)
  }, [])

  const handleWipOverrideConfirm = useCallback(() => {
    if (!wipOverrideDialog || !projectId) return

    updateTicket.mutate({
      projectId,
      ticketId: wipOverrideDialog.ticketId,
      updates: { phase: wipOverrideDialog.targetPhase, force: true }
    })

    setWipOverrideDialog(null)
  }, [wipOverrideDialog, projectId, updateTicket])

  const handleWipOverrideCancel = useCallback(() => {
    if (wipOverrideDialog) {
      toast.info('WIP limit reached', {
        description: `${wipOverrideDialog.phaseName} is at capacity. Move was cancelled.`
      })
    }
    setWipOverrideDialog(null)
  }, [wipOverrideDialog])

  // Loading state
  if (ticketsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-text-muted" />
      </div>
    )
  }

  // Error state
  if (ticketsError) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center text-accent-red">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
          <p>Failed to load tickets</p>
          <p className="text-sm text-text-muted mt-1">{ticketsError.message}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      {/* Board Header */}
      <div className="flex items-center justify-end px-4 py-3">
        <ViewToggle />
      </div>

      {/* Template Upgrade Banner */}
      <TemplateUpgradeBanner projectId={projectId} />

      {/* Divider */}
      <div className="border-b border-border" />

      {/* Board Content - Conditional Rendering */}
      {boardViewMode === 'table' ? (
        <TableView projectId={projectId} />
      ) : (
        <div className="flex-1 min-h-0 h-full">
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div ref={scrollContainerRef} className="board-scroll-container h-full overflow-x-auto overflow-y-hidden p-4">
              <div className="flex gap-4 h-full">
                {phases?.map((phase) => {
                  const phaseConfig = templateConfig?.phases.find((p) => p.name === phase)
                  const canAutomatePhase = canAutomate(phaseConfig, phase, phases)
                  const isAutomated = currentProject?.automatedPhases?.includes(phase) ?? false
                  const isMigrating = currentProject?.automatedPhaseMigration ?? false

                  return (
                    <BoardColumn
                      key={phase}
                      phase={phase}
                      tickets={ticketsByPhase[phase] || []}
                      projectId={projectId}
                      showAddTicket={phase === phases?.[0]}
                      canAutomate={canAutomatePhase}
                      isAutomated={isAutomated}
                      isMigrating={isMigrating}
                      onToggleAutomated={canAutomatePhase ? () => handleToggleAutomated(phase) : undefined}
                      swimlaneColor={currentProject?.swimlaneColors?.[phase]}
                      onColorChange={(color) => handleSwimlaneColorChange(phase, color)}
                      wipLimit={currentProject?.wipLimits?.[phase]}
                      onWipLimitChange={(limit) => handleWipLimitChange(phase, limit)}
                    />
                  )
                })}

                {/* Archived swimlane - appears after Done when toggled */}
                {showArchivedTickets && projectId && (
                  <ArchivedSwimlane projectId={projectId} />
                )}
              </div>
            </div>

            {/* Drag Overlay */}
            <DragOverlay>
              {activeTicket && (
                <div className="opacity-80">
                  <TicketCard ticket={activeTicket} projectId={projectId} />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {/* Automation Confirmation Dialog */}
      <Dialog
        open={confirmDialog?.open ?? false}
        onOpenChange={(open) => !open && handleCancelMove()}
      >
        <DialogContent className="bg-bg-secondary border-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">Start Automation?</DialogTitle>
            <DialogDescription className="text-text-secondary">
              Moving to <span className="font-medium text-accent">{confirmDialog?.phaseName}</span>{' '}
              will start Claude automation. Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelMove}>
              Cancel
            </Button>
            <Button onClick={handleConfirmMove}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WIP Override Dialog */}
      <Dialog
        open={wipOverrideDialog?.open ?? false}
        onOpenChange={(open) => !open && handleWipOverrideCancel()}
      >
        <DialogContent className="bg-bg-secondary border-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">Column at Capacity</DialogTitle>
            <DialogDescription className="text-text-secondary">
              <span className="font-medium text-amber-400">{wipOverrideDialog?.phaseName}</span>{' '}
              has reached its WIP limit. Moving this ticket will exceed the limit.
              {wipOverrideDialog?.hasAutomation && (
                <span className="block mt-2">
                  This phase also has automation that will start when the ticket moves.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleWipOverrideCancel}>
              Cancel
            </Button>
            <Button onClick={handleWipOverrideConfirm}>Move Anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
