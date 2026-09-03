export interface ConversationEntry {
  id: string
  question: string
  options?: string[]
  askedAt: string
  phase?: string
  answer?: string
  answeredAt?: string
}

export interface TicketPendingQuestion {
  conversationId: string
  question: string
  options?: string[]
  askedAt: string
  phase?: string
  claudeSessionId?: string
}

export interface TicketPendingResponse {
  question?: TicketPendingQuestion
}

export interface TicketMessage {
  type: 'question' | 'user' | 'notification' | 'artifact'
  text: string
  conversationId?: string
  options?: string[]
  timestamp: string
  artifact?: {
    filename: string
    description?: string
  }
  // Tags set by ChatService.getAdhocChatMetadata (artifact-chat / ticket-chat
  // sessions) so a specific artifact's Q&A panel can fetch and filter its
  // own history out of the shared ticket conversation on mount.
  metadata?: {
    artifactFilename?: string
    ticketChat?: boolean
    [key: string]: unknown
  }
}

export interface TicketMessagesResponse {
  messages: TicketMessage[]
}

export interface ArtifactChatMessage {
  type: 'question' | 'user' | 'error' | 'system'
  text: string
  conversationId?: string
  options?: string[]
  timestamp: string
}

export interface ArtifactChatPendingResponse {
  question?: {
    conversationId: string
    question: string
    options?: string[]
    askedAt: string
  }
  sessionActive: boolean
  endReason?: 'completed' | 'error' | 'timeout'
}

export interface ArtifactChatStartResponse {
  sessionId: string
  contextId: string
}
