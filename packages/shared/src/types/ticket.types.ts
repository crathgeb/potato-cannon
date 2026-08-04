export interface Ticket {
  id: string
  title: string
  description?: string
  phase: string
  project?: string
  createdAt: string
  updatedAt: string
  images?: string[]
  history: TicketHistoryEntry[]
  archived?: boolean
  archivedAt?: string
  conversationId?: string
  pendingPhase?: string
  epicId?: string
  blocked?: boolean
  blockedAt?: string
}

export interface ArchiveResult {
  ticket: Ticket
  cleanup: {
    worktreeRemoved: boolean
    branchRemoved: boolean
    errors: string[]
  }
}

export interface HistorySessionRecord {
  sessionId: string
  source: string
  startedAt: string
  endedAt?: string
  exitCode?: number
}

export interface TicketHistoryEntry {
  phase: string
  at: string
  sessionId?: string
  sessions?: HistorySessionRecord[]
  endedAt?: string
  reason?: string
}
