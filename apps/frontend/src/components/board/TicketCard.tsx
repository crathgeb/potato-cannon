import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Archive, Image, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { cn, timeAgo } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import { useArchiveTicket, useEpics } from '@/hooks/queries'
import { ListItemCard } from '@/components/ui/list-item-card'
import { IconButton } from '@/components/ui/icon-button'
import { ArchiveConfirmDialog, shouldShowArchiveWarning } from '@/components/ticket-detail/ArchiveConfirmDialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import type { Ticket } from '@potato-cannon/shared'

interface TicketCardProps {
  ticket: Ticket
  projectId: string
  swimlaneColor?: string
}

export function TicketCard({ ticket, projectId, swimlaneColor }: TicketCardProps) {
  const openTicketSheet = useAppStore((s) => s.openTicketSheet)
  const isProcessing = useAppStore((s) => s.isTicketProcessing(projectId, ticket.id))
  const activity = useAppStore((s) => s.getTicketActivity(projectId, ticket.id))
  const isPending = useAppStore((s) => s.isTicketPending(projectId, ticket.id))
  const isArchiving = useAppStore((s) => s.isTicketArchiving(projectId, ticket.id))
  const ticketSheetTicketId = useAppStore((s) => s.ticketSheetTicketId)
  const isSelected = ticketSheetTicketId === ticket.id
  const { data: epics } = useEpics(projectId)
  const ticketEpic = epics?.find((e) => e.id === ticket.epicId)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const archiveTicket = useArchiveTicket()

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    disabled: isArchiving,
    data: {
      ticket,
      projectId
    }
  })

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 50 : undefined
      }
    : undefined

  const handleClick = () => {
    if (isArchiving) return
    openTicketSheet(projectId, ticket.id)
  }

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation() // Don't trigger card click
    if (shouldShowArchiveWarning()) {
      setArchiveConfirmOpen(true)
    } else {
      handleArchive()
    }
  }

  const handleArchive = () => {
    archiveTicket.mutate(
      { projectId, ticketId: ticket.id },
      {
        onSuccess: (result) => {
          setArchiveConfirmOpen(false)
          if (result.cleanup.errors.length > 0) {
            toast.warning('Ticket archived', {
              description: `Could not clean up: ${result.cleanup.errors.join(', ')}`
            })
          } else {
            toast.success('Ticket archived')
          }
        },
        onError: (error) => {
          toast.error('Failed to archive ticket', {
            description: (error as Error).message
          })
        }
      }
    )
  }

  const imageCount = ticket.images?.length ?? 0
  const blockReason = ticket.phase === 'Blocked'
    ? [...(ticket.history ?? [])].reverse().find(h => h.phase === 'Blocked')?.reason
    : undefined

  return (
    <ListItemCard
      asChild
      isActive={isDragging}
      isSelected={isSelected}
      selectedVariant="bold"
      tintColor={swimlaneColor}
    >
      <div
        ref={setNodeRef}
        style={style}
        {...listeners}
        {...attributes}
        onClick={handleClick}
        className={cn(
          'relative group',
          isProcessing && 'ticket-card-processing',
          isProcessing && isSelected && 'ticket-card-selected',
          isArchiving && 'opacity-50 pointer-events-none cursor-not-allowed',
          ticket.blocked && 'border-2 border-red-500 ring-1 ring-red-500/50'
        )}
      >
      {/* Archive button - only for Done phase */}
      {ticket.phase === 'Done' && !ticket.archived && (
        <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <IconButton
            tooltip="Archive"
            onClick={handleArchiveClick}
            disabled={archiveTicket.isPending}
          >
            <Archive className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {/* Pending question badge */}
      {isPending && (
        <div className="absolute top-1.5 right-1.5 z-10">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-bold animate-pending-glow">
            ?
          </span>
        </div>
      )}

      {/* Pending phase indicator - ticket waiting for WIP space */}
      {ticket.pendingPhase && !isPending && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="absolute top-1.5 right-1.5 z-10">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-500/20 text-blue-400">
                <Clock className="h-3 w-3" />
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">Waiting for {ticket.pendingPhase}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Ticket ID + Epic badge */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-xs text-text-muted font-mono">{ticket.id}</span>
        {ticketEpic && (
          <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono">
            {ticketEpic.identifier}
          </span>
        )}
      </div>

      {/* Ticket Title */}
      <div className="text-text-primary text-sm font-medium line-clamp-2 mb-2">
        {ticket.title}
      </div>

      {/* Block reason subtitle */}
      {blockReason && (
        <p className="text-xs text-amber-400 line-clamp-2 mb-2 -mt-1">
          {blockReason}
        </p>
      )}

      {/* Meta row */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <div className="flex items-center gap-2 min-w-0">
          {isProcessing ? (
            <span className="flex items-center gap-1 text-accent truncate">
              <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse shrink-0" />
              <span className="truncate">{activity || 'Processing...'}</span>
            </span>
          ) : (
            <>
              {imageCount > 0 && (
                <span className="flex items-center gap-1">
                  <Image className="h-3 w-3" />
                  {imageCount}
                </span>
              )}
            </>
          )}
        </div>
        <span className="flex items-center gap-1 shrink-0">
          <Clock className="h-3 w-3" />
          {timeAgo(ticket.updatedAt)}
        </span>
      </div>

      <ArchiveConfirmDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        onConfirm={handleArchive}
        isPending={archiveTicket.isPending}
        ticketId={ticket.id}
      />
      </div>
    </ListItemCard>
  )
}
