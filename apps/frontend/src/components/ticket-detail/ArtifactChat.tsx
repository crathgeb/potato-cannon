import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react'
import { Send, Loader2, AlertCircle, MessageSquare, X } from 'lucide-react'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn, timeAgo } from '@/lib/utils'
import { Linkify } from '@/components/ui/linkify'
import { useBrainstormMessage, useSessionEnded } from '@/hooks/useSSE'
import type { ArtifactChatMessage } from '@potato-cannon/shared'

interface ArtifactChatProps {
  projectId: string
  ticketId: string
  artifactFilename: string
  onClose?: () => void
  onSessionEnd?: () => void
}

export function ArtifactChat({
  projectId,
  ticketId,
  artifactFilename,
  onClose,
  onSessionEnd
}: ArtifactChatProps) {
  const [messages, setMessages] = useState<ArtifactChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [contextId, setContextId] = useState<string | null>(null)
  const [sessionActive, setSessionActive] = useState(false)
  const [endReason, setEndReason] = useState<string | null>(null)
  const [pendingOptions, setPendingOptions] = useState<string[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastConversationIdRef = useRef<string | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  // Fetch this artifact's prior Q&A history on mount, filtered out of the
  // shared ticket conversation by the artifactFilename tag ChatService
  // attaches (see getAdhocChatMetadata in chat.service.ts). Without this,
  // every previous exchange with this exact panel was lost the moment it
  // closed - the panel kept messages only in local state, nothing was ever
  // fetched back. Does not resume any live session automatically - a new
  // question here still starts a fresh one - just restores what to look at.
  useEffect(() => {
    let active = true
    setIsLoadingHistory(true)
    api.getTicketMessages(projectId, ticketId)
      .then((response) => {
        if (!active) return
        const history = response.messages
          .filter((m) => m.metadata?.artifactFilename === artifactFilename)
          .map((m): ArtifactChatMessage => ({
            type: m.type === 'notification' || m.type === 'artifact' ? 'system' : m.type,
            text: m.text,
            conversationId: m.conversationId,
            options: m.options,
            timestamp: m.timestamp
          }))
        setMessages(history)
      })
      .catch(() => {
        // Non-fatal - panel still works for a fresh question, just without
        // prior history restored.
      })
      .finally(() => {
        if (active) setIsLoadingHistory(false)
      })
    return () => { active = false }
  }, [projectId, ticketId, artifactFilename])

  // Scroll to bottom when messages change
  useEffect(() => {
    if (isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Track scroll position
  useEffect(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return

    const viewport = scrollArea.querySelector('[data-radix-scroll-area-viewport]')
    if (!viewport) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      const atBottom = scrollHeight - scrollTop - clientHeight < 50
      isAtBottomRef.current = atBottom
    }

    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  // Subscribe to brainstorm messages (artifact chats use brainstorm infrastructure)
  useBrainstormMessage(useCallback((data: { brainstormId?: string; message?: { type?: string; text?: string; conversationId?: string; options?: string[]; timestamp?: string } }) => {
    // Only process messages for this artifact chat session
    if (data.brainstormId !== contextId) return

    const msg = data.message
    if (!msg || !msg.type || !msg.text) return

    if (msg.type === 'question') {
      // Check if message already exists
      const conversationId = msg.conversationId
      const text = msg.text // Captured above null check
      const options = msg.options
      const timestamp = msg.timestamp || new Date().toISOString()
      setMessages(prev => {
        if (conversationId) {
          const alreadyExists = prev.some(m => m.conversationId === conversationId)
          if (alreadyExists) return prev
        }
        lastConversationIdRef.current = conversationId || null
        return [
          ...prev,
          {
            type: 'question' as const,
            text,
            conversationId,
            options,
            timestamp
          }
        ]
      })
      setPendingOptions(Array.isArray(options) ? options : [])
      setIsWaitingForResponse(false)
    }
  }, [contextId]))

  // Subscribe to session ended events
  useSessionEnded(useCallback((data: { brainstormId?: string; status?: string }) => {
    // Only process events for this artifact chat session
    if (data.brainstormId !== contextId) return

    setSessionActive(false)
    setEndReason(data.status === 'failed' ? 'error' : 'completed')
    onSessionEnd?.()
  }, [contextId, onSessionEnd]))

  const startSession = useCallback(async (message: string) => {
    setIsStarting(true)

    // Add user message immediately - appended, not replacing, so restored
    // history from the fetch-on-mount above stays visible.
    setMessages(prev => [...prev, {
      type: 'user',
      text: message,
      timestamp: new Date().toISOString()
    }])

    try {
      const response = await api.startArtifactChat(
        projectId,
        ticketId,
        artifactFilename,
        message
      )
      setContextId(response.contextId)
      setSessionActive(true)
      setIsWaitingForResponse(true)
    } catch (error) {
      setMessages(prev => [
        ...prev,
        {
          type: 'error',
          text: error instanceof Error ? error.message : 'Failed to start chat session',
          timestamp: new Date().toISOString()
        }
      ])
    } finally {
      setIsStarting(false)
    }
  }, [projectId, ticketId, artifactFilename])

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || isSubmitting) return

    const messageText = text.trim()
    setInput('')
    setPendingOptions([])

    // If no session yet, start one
    if (!contextId) {
      await startSession(messageText)
      return
    }

    setIsSubmitting(true)

    // Add user message immediately
    setMessages(prev => [
      ...prev,
      {
        type: 'user',
        text: messageText,
        timestamp: new Date().toISOString()
      }
    ])

    try {
      await api.sendArtifactChatInput(
        projectId,
        ticketId,
        artifactFilename,
        contextId,
        messageText
      )
      lastConversationIdRef.current = null
      setIsWaitingForResponse(true)
    } catch (error) {
      setMessages(prev => [
        ...prev,
        {
          type: 'error',
          text: error instanceof Error ? error.message : 'Failed to send message',
          timestamp: new Date().toISOString()
        }
      ])
    } finally {
      setIsSubmitting(false)
      textareaRef.current?.focus()
    }
  }, [projectId, ticketId, artifactFilename, contextId, isSubmitting, startSession])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend(input)
    }
  }

  const handleOptionClick = (option: string) => {
    handleSend(option)
  }

  // Get contextId for cleanup on unmount
  const contextIdRef = useRef<string | null>(null)
  useEffect(() => {
    contextIdRef.current = contextId
  }, [contextId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (contextIdRef.current) {
        api.endArtifactChat(
          projectId,
          ticketId,
          artifactFilename,
          contextIdRef.current
        ).catch(console.error)
      }
    }
  }, [projectId, ticketId, artifactFilename])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <MessageSquare className="h-4 w-4 text-text-muted" />
        <h3 className="text-text-secondary font-semibold text-[13px]">
          Ask about this artifact
        </h3>
        {sessionActive && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-accent-green">
            <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
            Active
          </span>
        )}
        {!sessionActive && endReason && (
          <span className="ml-auto text-xs text-text-muted">
            Session ended
          </span>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-text-muted hover:text-text-primary transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Messages area */}
      <ScrollArea ref={scrollAreaRef} className="flex-1 min-h-0 px-4">
        <div className="space-y-4 py-4">
          {isLoadingHistory && (
            <div className="text-center py-8 text-text-muted text-sm flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading conversation...
            </div>
          )}

          {!isLoadingHistory && messages.length === 0 && !isStarting && (
            <div className="text-center py-8 text-text-muted text-sm">
              Ask a question about this artifact to start a conversation
            </div>
          )}

          {messages.map((message, index) => (
            <MessageBubble key={index} message={message} />
          ))}

          {(isWaitingForResponse || isStarting) && <ThinkingIndicator />}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Option buttons */}
      {pendingOptions.length > 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-2">
          {pendingOptions.map((option, index) => (
            <Button
              key={index}
              variant="outline"
              size="sm"
              onClick={() => handleOptionClick(option)}
              className="text-xs whitespace-normal h-auto min-h-8 text-left shrink"
            >
              {option}
            </Button>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="p-3 border-t border-border">
        <div className="flex gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              !sessionActive && endReason
                ? 'Session ended'
                : 'Ask a question...'
            }
            className="min-h-[44px] max-h-[120px] resize-none"
            disabled={isSubmitting || isStarting || (!sessionActive && !!endReason)}
          />
          <Button
            onClick={() => handleSend(input)}
            disabled={
              !input.trim() ||
              isSubmitting ||
              isStarting ||
              (!sessionActive && !!endReason)
            }
            size="icon"
            className="shrink-0 self-end"
          >
            {isSubmitting || isStarting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
        {sessionActive && (
          <p className="text-xs text-text-muted mt-2">
            Press Enter to send, Shift+Enter for new line
          </p>
        )}
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: ArtifactChatMessage
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.type === 'user'
  const isError = message.type === 'error'
  const isSystem = message.type === 'system'

  return (
    <div
      className={cn(
        'flex',
        isUser ? 'justify-end' : 'justify-start'
      )}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-4 py-3 leading-normal',
          isUser && 'bg-accent text-accent-foreground rounded-br-sm',
          message.type === 'question' && 'bg-bg-tertiary rounded-bl-sm',
          isSystem && 'bg-bg-tertiary text-text-muted italic rounded-bl-sm',
          isError && 'bg-destructive/10 border border-destructive/20 text-destructive'
        )}
      >
        {isError && (
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle className="h-4 w-4" />
            <span className="text-xs font-medium">Error</span>
          </div>
        )}
        <p className="text-sm whitespace-pre-wrap break-words">
          <Linkify text={message.text || ''} />
        </p>
        {message.timestamp && (
          <p className="text-xs opacity-60 mt-1">
            {timeAgo(message.timestamp)}
          </p>
        )}
      </div>
    </div>
  )
}

function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-bg-tertiary rounded-lg rounded-bl-sm px-4 py-3">
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" />
        </div>
      </div>
    </div>
  )
}
