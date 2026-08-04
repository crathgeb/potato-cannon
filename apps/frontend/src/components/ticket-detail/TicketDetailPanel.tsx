import { useState, useMemo, useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { Loader2, X, ArrowLeft, ArrowRight, Ban } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import {
  useTicket,
  useProjectPhases,
  useUpdateTicket,
  useProjects,
  useTemplate,
  useEpics,
  useAssignTicketToEpic,
} from '@/hooks/queries'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/utils'
import { DetailsTab } from './DetailsTab'
import { SettingsTab } from './SettingsTab'
import { ActivityTab } from './ActivityTab'
import type { TemplatePhase } from '@potato-cannon/shared'

/**
 * Checks if a phase has automation configured (workers array with items)
 */
function phaseHasAutomation(phaseConfig: TemplatePhase | undefined): boolean {
  if (!phaseConfig) return false
  return !!(phaseConfig.workers && phaseConfig.workers.length > 0)
}

/**
 * Ticket detail panel that pushes content instead of overlaying it.
 * Unlike a Sheet/drawer, this component participates in the flex layout
 * and causes the main content area to shrink when open.
 */
export function TicketDetailPanel() {
  const ticketSheetOpen = useAppStore((s) => s.ticketSheetOpen)
  const ticketSheetTicketId = useAppStore((s) => s.ticketSheetTicketId)
  const ticketSheetProjectId = useAppStore((s) => s.ticketSheetProjectId)
  const closeTicketSheet = useAppStore((s) => s.closeTicketSheet)
  const currentProjectId = useAppStore((s) => s.currentProjectId)
  const openEpicSheet = useAppStore((s) => s.openEpicSheet)
  const navigate = useNavigate()
  const { data: epics } = useEpics(currentProjectId)
  const assignToEpic = useAssignTicketToEpic()

  // Only show panel on board view and when viewing the same project where the ticket was opened
  const location = useLocation()
  const isOnBoardView = !!location.pathname.match(/^\/projects\/[^/]+\/board/)
  const isCorrectProject = currentProjectId === ticketSheetProjectId

  // Queries
  const { data: ticket, isLoading } = useTicket(currentProjectId, ticketSheetTicketId)
  const { data: phases } = useProjectPhases(currentProjectId)
  const { data: projects } = useProjects()
  const updateTicket = useUpdateTicket()

  // Get current project to access template name
  const currentProject = useMemo(
    () => projects?.find((p) => p.id === currentProjectId),
    [projects, currentProjectId]
  )

  const { data: templateConfig } = useTemplate(currentProject?.template?.name ?? null)

  // Phase change confirmation dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    targetPhase: string
  } | null>(null)

  // Tab state - resets to phase-based default when ticket changes
  const [activeTab, setActiveTab] = useState<string>('details')

  // Reset tab to phase-based default when ticket changes
  useEffect(() => {
    if (!ticket || !templateConfig) return
    const phaseConfig = templateConfig.phases.find((p) => p.name === ticket.phase)
    const newDefault = phaseHasAutomation(phaseConfig) ? 'activity' : 'details'
    setActiveTab(newDefault)
  }, [ticketSheetTicketId, ticket?.phase, templateConfig])

  // Build phase breadcrumb from history
  const phaseBreadcrumb = useMemo(() => {
    if (!ticket?.history || ticket.history.length === 0) return null
    // Show last 3 phases
    const recent = ticket.history.slice(-3)
    return recent.map((h) => h.phase)
  }, [ticket?.history])

  const handlePhaseChange = useCallback(
    (newPhase: string) => {
      if (!currentProjectId || !ticketSheetTicketId || newPhase === ticket?.phase) return

      // Check if target phase has automation
      const phaseConfig = templateConfig?.phases.find((p) => p.name === newPhase)
      const hasAutomation = phaseHasAutomation(phaseConfig)

      if (hasAutomation) {
        setConfirmDialog({
          open: true,
          targetPhase: newPhase
        })
      } else {
        updateTicket.mutate({
          projectId: currentProjectId,
          ticketId: ticketSheetTicketId,
          updates: { phase: newPhase }
        })
      }
    },
    [currentProjectId, ticketSheetTicketId, ticket?.phase, templateConfig, updateTicket]
  )

  // Promote/Demote step through the real phase sequence, skipping "Blocked"
  // - that's a separate off-ramp column, not a normal step in the pipeline.
  const promotableSequence = useMemo(
    () => (phases ?? []).filter((p) => p !== 'Blocked'),
    [phases]
  )
  const currentPhaseIndex = ticket ? promotableSequence.indexOf(ticket.phase) : -1
  const demoteTarget = currentPhaseIndex > 0 ? promotableSequence[currentPhaseIndex - 1] : null
  const promoteTarget =
    currentPhaseIndex >= 0 && currentPhaseIndex < promotableSequence.length - 1
      ? promotableSequence[currentPhaseIndex + 1]
      : null

  const handleToggleBlock = useCallback(() => {
    if (!currentProjectId || !ticketSheetTicketId || !ticket) return
    updateTicket.mutate({
      projectId: currentProjectId,
      ticketId: ticketSheetTicketId,
      updates: { blocked: !ticket.blocked }
    })
  }, [currentProjectId, ticketSheetTicketId, ticket, updateTicket])

  const handleConfirmMove = useCallback(() => {
    if (!confirmDialog || !currentProjectId || !ticketSheetTicketId) return

    updateTicket.mutate({
      projectId: currentProjectId,
      ticketId: ticketSheetTicketId,
      updates: { phase: confirmDialog.targetPhase }
    })

    setConfirmDialog(null)
  }, [confirmDialog, currentProjectId, ticketSheetTicketId, updateTicket])

  const isOpen = ticketSheetOpen && isOnBoardView && isCorrectProject

  // Handle escape key to close panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      // Don't close if a Radix dialog is open (it handles its own escape)
      // Must check data-state="open" - the data-slot attribute is static and exists
      // even when the dialog is closed
      const openDialog = document.querySelector('[data-slot="dialog-content"][data-state="open"]')
      if (openDialog) return

      // If focus is in an input/textarea, blur it instead of closing
      const activeElement = document.activeElement
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        activeElement.blur()
        return
      }

      // Close the panel
      closeTicketSheet()
    }

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, closeTicketSheet])

  return (
    <>
      <div
        className="ticket-detail-panel"
        data-open={isOpen}
      >
        <div className="flex flex-col h-full w-[480px] max-w-full">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-text-muted" />
            </div>
          ) : ticket ? (
            <>
              {/* Header with close button */}
              <div className="flex items-start justify-between p-4 pb-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-text-muted font-mono text-xs">
                      {ticket.id}
                    </Badge>
                    {(() => {
                      const ticketEpic = epics?.find((e) => e.id === ticket.epicId)
                      return ticketEpic ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (ticketSheetProjectId) {
                              const projectSlug = location.pathname.match(/^\/projects\/([^/]+)/)?.[1]
                              if (projectSlug) {
                                navigate({ to: '/projects/$projectId/epics', params: { projectId: projectSlug } })
                                openEpicSheet(ticketSheetProjectId, ticketEpic.id)
                              }
                            }
                          }}
                          className="text-xs px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors"
                        >
                          {ticketEpic.identifier}
                        </button>
                      ) : null
                    })()}

                    {/* Demote / Block / Promote - small, sits between the ID pill and the close button */}
                    <div className="flex items-end gap-1 mx-auto self-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-4 rounded-full px-1.5 py-0 text-[8px] leading-none border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-40"
                        disabled={!demoteTarget || updateTicket.isPending}
                        onClick={() => demoteTarget && handlePhaseChange(demoteTarget)}
                        title={demoteTarget ? `Send back to ${demoteTarget}` : 'Already at the first phase'}
                      >
                        <ArrowLeft className="h-2 w-2 mr-0.5" />
                        Demote
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className={
                          ticket.blocked
                            ? 'h-4 rounded-full px-1.5 py-0 text-[8px] leading-none border-red-500 bg-red-500 text-white hover:bg-red-600 hover:border-red-600'
                            : 'h-4 rounded-full px-1.5 py-0 text-[8px] leading-none border-border text-text-muted hover:text-text-primary'
                        }
                        disabled={updateTicket.isPending}
                        onClick={handleToggleBlock}
                        title={ticket.blocked ? 'Unblock this ticket' : 'Block this ticket'}
                      >
                        <Ban className="h-2 w-2 mr-0.5" />
                        {ticket.blocked ? 'Blocked' : 'Block'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-4 rounded-full px-1.5 py-0 text-[8px] leading-none border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20 hover:text-green-300 disabled:opacity-40"
                        disabled={!promoteTarget || updateTicket.isPending}
                        onClick={() => promoteTarget && handlePhaseChange(promoteTarget)}
                        title={promoteTarget ? `Advance to ${promoteTarget}` : 'Already at the last phase'}
                      >
                        Promote
                        <ArrowRight className="h-2 w-2 ml-0.5" />
                      </Button>
                    </div>
                  </div>
                  <h2 className="text-text-primary text-lg font-semibold">
                    {ticket.title}
                  </h2>

                  {/* Phase breadcrumb */}
                  {phaseBreadcrumb && phaseBreadcrumb.length > 1 && (
                    <p className="text-xs text-text-muted flex items-center gap-1 mt-1">
                      {phaseBreadcrumb.map((phase, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span>{'>'}</span>}
                          <span className={i === phaseBreadcrumb.length - 1 ? 'text-text-secondary' : ''}>
                            {phase}
                          </span>
                        </span>
                      ))}
                    </p>
                  )}

                  {/* Timestamps */}
                  <p className="text-xs text-text-muted mt-2">
                    Created {timeAgo(ticket.createdAt)} • Updated {timeAgo(ticket.updatedAt)}
                  </p>

                  {/* Epic assignment */}
                  {epics && epics.length > 0 && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs text-text-muted">Epic:</span>
                      <Select
                        value={ticket.epicId || '__none__'}
                        onValueChange={(value) => {
                          if (!currentProjectId || !ticketSheetTicketId) return
                          assignToEpic.mutate({
                            projectId: currentProjectId,
                            ticketId: ticketSheetTicketId,
                            epicId: value === '__none__' ? null : value,
                          })
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs w-[200px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {epics.map((epic) => (
                            <SelectItem key={epic.id} value={epic.id}>
                              {epic.identifier} — {epic.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Phase selector - mobile only */}
                  <div className="mt-4 flex items-center gap-2 sm:hidden">
                    <span className="text-sm text-text-secondary">Phase:</span>
                    <Select value={ticket.phase} onValueChange={handlePhaseChange}>
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {phases?.map((phase) => (
                          <SelectItem key={phase} value={phase}>
                            {phase}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Close button */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-text-muted hover:text-text-primary"
                  onClick={closeTicketSheet}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </Button>
              </div>

              {/* Tabs */}
              <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
                <TabsList className="mx-4 mt-4 mb-2 w-fit">
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="details">Details</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>

                <TabsContent value="activity" className="mt-0 flex-1 flex flex-col min-h-0">
                  <ActivityTab
                    projectId={currentProjectId!}
                    ticketId={ticket.id}
                    currentPhase={ticket.phase}
                    history={ticket.history}
                    archived={ticket.archived}
                  />
                </TabsContent>
                <TabsContent value="details" className="mt-0 flex-1 min-h-0">
                  <ScrollArea className="h-full">
                    <div className="px-4 pb-4">
                      <DetailsTab
                        projectId={currentProjectId!}
                        ticketId={ticket.id}
                        description={ticket.description}
                        history={ticket.history}
                      />
                    </div>
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="settings" className="mt-0 flex-1 min-h-0">
                  <ScrollArea className="h-full">
                    <div className="px-4 pb-4">
                      <SettingsTab
                        projectId={currentProjectId!}
                        ticketId={ticket.id}
                        ticket={{ phase: ticket.phase, archived: ticket.archived }}
                        onDeleted={closeTicketSheet}
                        onArchived={closeTicketSheet}
                      />
                    </div>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-text-muted">Ticket not found</p>
            </div>
          )}
        </div>
      </div>

      {/* Phase Change Confirmation Dialog */}
      <Dialog
        open={confirmDialog?.open ?? false}
        onOpenChange={(open) => !open && setConfirmDialog(null)}
      >
        <DialogContent className="bg-bg-secondary border-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">Start Automation?</DialogTitle>
            <DialogDescription className="text-text-secondary">
              Moving to <span className="font-medium text-accent">{confirmDialog?.targetPhase}</span>{' '}
              will start Claude automation. Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog(null)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmMove}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
