import crypto from "crypto";

export interface ArtifactChatSession {
  sessionId: string;
  contextId: string;
  projectId: string;
  ticketId: string;
  // Absent means this is a ticket-wide Q&A session (see
  // registerTicketChatRoutes), not scoped to one artifact.
  artifactFilename?: string;
  active: boolean;
  endReason?: "completed" | "error" | "timeout";
  createdAt: string;
  lastActivityAt: string;
}

class ArtifactChatStore {
  private sessions = new Map<string, ArtifactChatSession>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  private static readonly TTL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  createSession(
    projectId: string,
    ticketId: string,
    artifactFilename?: string
  ): ArtifactChatSession {
    const sessionId = `artsess_${crypto.randomBytes(8).toString("hex")}`;
    // Prefix distinguishes ticket-wide sessions in logs/DB rows at a glance;
    // both flow through the exact same context_id-based routing/resume path.
    const contextId = `${artifactFilename ? "artchat" : "ticketchat"}_${crypto.randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();

    const session: ArtifactChatSession = {
      sessionId,
      contextId,
      projectId,
      ticketId,
      artifactFilename,
      active: true,
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(contextId, session);
    return session;
  }

  getSession(contextId: string): ArtifactChatSession | undefined {
    return this.sessions.get(contextId);
  }

  updateActivity(contextId: string): void {
    const session = this.sessions.get(contextId);
    if (session) {
      session.lastActivityAt = new Date().toISOString();
    }
  }

  endSession(
    contextId: string,
    reason: "completed" | "error" | "timeout"
  ): void {
    const session = this.sessions.get(contextId);
    if (session) {
      session.active = false;
      session.endReason = reason;
    }
  }

  deleteSession(contextId: string): void {
    this.sessions.delete(contextId);
  }

  getActiveSessionForArtifact(
    projectId: string,
    ticketId: string,
    artifactFilename: string
  ): ArtifactChatSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.projectId === projectId &&
        session.ticketId === ticketId &&
        session.artifactFilename === artifactFilename &&
        session.active
      ) {
        return session;
      }
    }
    return undefined;
  }

  getActiveSessionForTicket(
    projectId: string,
    ticketId: string
  ): ArtifactChatSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.projectId === projectId &&
        session.ticketId === ticketId &&
        !session.artifactFilename &&
        session.active
      ) {
        return session;
      }
    }
    return undefined;
  }

  startCleanupTimer(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(
      () => this.cleanupStale(),
      ArtifactChatStore.CLEANUP_INTERVAL_MS
    );
  }

  stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > ArtifactChatStore.TTL_MS) {
        console.log(
          `[ArtifactChatStore] Cleaning up stale session: ${session.contextId}`
        );
        this.sessions.delete(key);
      }
    }
  }

  clearAll(): void {
    this.sessions.clear();
  }

  getAllSessions(): ArtifactChatSession[] {
    return Array.from(this.sessions.values());
  }
}

export const artifactChatStore = new ArtifactChatStore();
