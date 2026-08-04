import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";
import type {
  StoredSession,
  CreateSessionInput,
} from "../types/session.types.js";

// =============================================================================
// Row Types
// =============================================================================

interface SessionRow {
  id: string;
  project_id: string;
  ticket_id: string | null;
  brainstorm_id: string | null;
  conversation_id: string | null;
  claude_session_id: string | null;
  agent_source: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  phase: string | null;
  metadata: string | null;
}

// =============================================================================
// Row Mappers
// =============================================================================

function rowToSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id || undefined,
    brainstormId: row.brainstorm_id || undefined,
    conversationId: row.conversation_id || undefined,
    claudeSessionId: row.claude_session_id || undefined,
    agentSource: row.agent_source || undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at || undefined,
    exitCode: row.exit_code ?? undefined,
    phase: row.phase || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

// =============================================================================
// SessionStore Class
// =============================================================================

export class SessionStore {
  constructor(private db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // Session Lifecycle
  // ---------------------------------------------------------------------------

  createSession(input: CreateSessionInput): StoredSession {
    const id = `sess_${randomUUID().replace(/-/g, "").substring(0, 16)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, ticket_id, brainstorm_id, claude_session_id, agent_source, started_at, phase, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.ticketId || null,
        input.brainstormId || null,
        input.claudeSessionId || null,
        input.agentSource || null,
        now,
        input.phase || null,
        input.metadata ? JSON.stringify(input.metadata) : null
      );

    return this.getSession(id)!;
  }

  endSession(sessionId: string, exitCode?: number): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE sessions SET ended_at = ?, exit_code = ? WHERE id = ?")
      .run(now, exitCode ?? null, sessionId);
    return result.changes > 0;
  }

  getSession(sessionId: string): StoredSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?")
      .run(claudeSessionId, sessionId);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getSessionsByTicket(ticketId: string): StoredSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE ticket_id = ? ORDER BY started_at")
      .all(ticketId) as SessionRow[];

    return rows.map(rowToSession);
  }

  getSessionsByBrainstorm(brainstormId: string): StoredSession[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM sessions WHERE brainstorm_id = ? ORDER BY started_at"
      )
      .all(brainstormId) as SessionRow[];

    return rows.map(rowToSession);
  }

  getActiveSessionForTicket(ticketId: string): StoredSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ticket_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(ticketId) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  getActiveSessionForBrainstorm(brainstormId: string): StoredSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE brainstorm_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(brainstormId) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  hasActiveSession(ticketId?: string, brainstormId?: string): boolean {
    if (ticketId) {
      return this.getActiveSessionForTicket(ticketId) !== null;
    }
    if (brainstormId) {
      return this.getActiveSessionForBrainstorm(brainstormId) !== null;
    }
    return false;
  }

  getLatestClaudeSessionId(brainstormId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT claude_session_id FROM sessions
         WHERE brainstorm_id = ? AND claude_session_id IS NOT NULL
         ORDER BY started_at DESC, ROWID DESC LIMIT 1`
      )
      .get(brainstormId) as { claude_session_id: string } | undefined;

    return row?.claude_session_id || null;
  }

  getLatestClaudeSessionIdForTicket(ticketId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT claude_session_id FROM sessions
         WHERE ticket_id = ? AND claude_session_id IS NOT NULL
         ORDER BY started_at DESC, ROWID DESC LIMIT 1`
      )
      .get(ticketId) as { claude_session_id: string } | undefined;

    return row?.claude_session_id || null;
  }

  /**
   * When the same ticket resumes, this is the cutoff for "new since you last
   * ran" - the end time of the same session getLatestClaudeSessionIdForTicket
   * would resume. Same WHERE/ORDER as that query so it always refers to the
   * identical row; a session still running (ended_at NULL) can't be resumed
   * from anyway, so this only ever matters once ended_at is set.
   */
  getLatestSessionEndedAtForTicket(ticketId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT ended_at FROM sessions
         WHERE ticket_id = ? AND claude_session_id IS NOT NULL
         ORDER BY started_at DESC, ROWID DESC LIMIT 1`
      )
      .get(ticketId) as { ended_at: string | null } | undefined;

    return row?.ended_at || null;
  }

  /**
   * Delete all sessions for a ticket that occurred in or after the specified phases.
   * Also ends any active sessions for these phases.
   */
  deleteSessionsForPhases(ticketId: string, phases: string[]): number {
    if (phases.length === 0) return 0;

    const placeholders = phases.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `DELETE FROM sessions WHERE ticket_id = ? AND phase IN (${placeholders})`
      )
      .run(ticketId, ...phases);
    return result.changes;
  }
}

// =============================================================================
// Factory & Convenience Functions
// =============================================================================

export function createSessionStore(db: Database.Database): SessionStore {
  return new SessionStore(db);
}

// Singleton convenience functions
export function createStoredSession(input: CreateSessionInput): StoredSession {
  return new SessionStore(getDatabase()).createSession(input);
}

export function endStoredSession(
  sessionId: string,
  exitCode?: number
): boolean {
  return new SessionStore(getDatabase()).endSession(sessionId, exitCode);
}

export function getStoredSession(sessionId: string): StoredSession | null {
  return new SessionStore(getDatabase()).getSession(sessionId);
}

export function getSessionsByTicket(ticketId: string): StoredSession[] {
  return new SessionStore(getDatabase()).getSessionsByTicket(ticketId);
}

export function getSessionsByBrainstorm(brainstormId: string): StoredSession[] {
  return new SessionStore(getDatabase()).getSessionsByBrainstorm(brainstormId);
}

export function getActiveSessionForTicket(
  ticketId: string
): StoredSession | null {
  return new SessionStore(getDatabase()).getActiveSessionForTicket(ticketId);
}

export function getActiveSessionForBrainstorm(
  brainstormId: string
): StoredSession | null {
  return new SessionStore(getDatabase()).getActiveSessionForBrainstorm(
    brainstormId
  );
}

export function hasActiveStoredSession(
  ticketId?: string,
  brainstormId?: string
): boolean {
  return new SessionStore(getDatabase()).hasActiveSession(
    ticketId,
    brainstormId
  );
}

export function getLatestClaudeSessionId(brainstormId: string): string | null {
  return new SessionStore(getDatabase()).getLatestClaudeSessionId(brainstormId);
}

export function getLatestClaudeSessionIdForTicket(ticketId: string): string | null {
  return new SessionStore(getDatabase()).getLatestClaudeSessionIdForTicket(ticketId);
}

export function getLatestSessionEndedAtForTicket(ticketId: string): string | null {
  return new SessionStore(getDatabase()).getLatestSessionEndedAtForTicket(ticketId);
}

export function updateClaudeSessionId(
  sessionId: string,
  claudeSessionId: string
): boolean {
  return new SessionStore(getDatabase()).updateClaudeSessionId(
    sessionId,
    claudeSessionId
  );
}

export function deleteSessionsForPhases(
  ticketId: string,
  phases: string[]
): number {
  return new SessionStore(getDatabase()).deleteSessionsForPhases(ticketId, phases);
}
