import { useState, useCallback } from 'react'
import { MessageSquare } from 'lucide-react'
import { ListItemCard } from '@/components/ui/list-item-card'
import { cn, timeAgo } from '@/lib/utils'
import { useBrainstormMessage } from '@/hooks/useSSE'
import type { Brainstorm } from '@potato-cannon/shared'

interface BrainstormListItemProps {
  brainstorm: Brainstorm
  projectId: string
  isSelected: boolean
  onSelect: () => void
}

function getSeenKey(projectId: string, brainstormId: string) {
  return `brainstorm-seen-${projectId}-${brainstormId}`
}

export function BrainstormListItem({
  brainstorm,
  projectId,
  isSelected,
  onSelect
}: BrainstormListItemProps) {
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null)
  const [lastSeenId, setLastSeenId] = useState<string | null>(() => {
    return localStorage.getItem(getSeenKey(projectId, brainstorm.id))
  })

  // Subscribe to brainstorm messages for real-time pending status
  useBrainstormMessage(useCallback((data: { brainstormId?: string; message?: { type?: string; conversationId?: string } }) => {
    // Only process messages for this brainstorm
    if (data.brainstormId !== brainstorm.id) return

    const msg = data.message
    if (!msg) return

    // Update pending status based on message type
    if (msg.type === 'question' && msg.conversationId) {
      setPendingConversationId(msg.conversationId)
    } else if (msg.type === 'user') {
      // User responded, clear pending
      setPendingConversationId(null)
    }
  }, [brainstorm.id]))

  // Mark as seen when clicked
  const handleSelect = useCallback(() => {
    if (pendingConversationId && pendingConversationId !== lastSeenId) {
      localStorage.setItem(getSeenKey(projectId, brainstorm.id), pendingConversationId)
      setLastSeenId(pendingConversationId)
    }
    onSelect()
  }, [projectId, brainstorm.id, pendingConversationId, lastSeenId, onSelect])

  // Determine if there's an unseen pending question
  const hasUnseenQuestion = pendingConversationId !== null && pendingConversationId !== lastSeenId

  const isThinking = brainstorm.status === 'active' && brainstorm.hasActiveSession && pendingConversationId === null

  return (
    <ListItemCard asChild isSelected={isSelected} className={cn(isThinking && 'thinking-shimmer')}>
      <button onClick={handleSelect} className="w-full text-left overflow-hidden">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <MessageSquare className="h-4 w-4 text-text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 min-w-0">
            <span className="font-medium text-text-primary truncate flex-1 min-w-0">
              {brainstorm.name}
            </span>
            <StatusIndicator
              hasUnseenQuestion={hasUnseenQuestion}
            />
          </div>
          <p className="text-xs text-text-muted">
            {timeAgo(brainstorm.updatedAt)}
          </p>
        </div>
      </div>
      </button>
    </ListItemCard>
  )
}

function StatusIndicator({
  hasUnseenQuestion
}: {
  hasUnseenQuestion: boolean
}) {
  // Active brainstorm with unseen pending question - show unread indicator
  if (hasUnseenQuestion) {
    return (
      <span className="shrink-0 flex items-center justify-center w-2 h-2 bg-accent rounded-full" />
    )
  }

  // Active but user has seen the pending question - no indicator
  return null
}
