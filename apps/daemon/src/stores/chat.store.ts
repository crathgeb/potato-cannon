import { getDatabase } from "./db.js";

// =============================================================================
// Cancellation Registry
// =============================================================================

/**
 * Map of contextId -> AbortController for active waitForResponse calls.
 * When a session is replaced, we cancel the old wait so it doesn't
 * process the response meant for the new session.
 */
const waitControllers: Map<string, AbortController> = new Map();

/**
 * Cancel any active waitForResponse for the given context.
 * Called before spawning a new session to prevent duplicate processing.
 */
export function cancelWaitForResponse(contextId: string): void {
  const controller = waitControllers.get(contextId);
  if (controller) {
    controller.abort();
    waitControllers.delete(contextId);
  }
}

/**
 * Create a new AbortController for waitForResponse.
 * Cancels any existing controller for this context first.
 */
export function createWaitController(contextId: string): AbortController {
  // Cancel any existing wait first
  cancelWaitForResponse(contextId);

  const controller = new AbortController();
  waitControllers.set(contextId, controller);
  return controller;
}

// =============================================================================
// Context Type Helpers
// =============================================================================

function deriveContextType(contextId: string): "ticket" | "brainstorm" | "artifact_chat" {
  if (contextId.startsWith("brain_")) return "brainstorm";
  // ticketchat_ (whole-ticket Q&A, see ticket-chat.routes.ts) is grouped
  // under the same type as artchat_ - both are ad-hoc Q&A sessions that
  // must NOT count as a real, ticket-workflow-blocking pending question
  // (see getPendingQuestionsByProject's WHERE context_type = 'ticket'
  // filter). Before this, a ticket-chat session's context_id (a
  // "ticketchat_..." string, not a real ticket ID) leaked into the
  // pendingTicketIds heartbeat as if it were one.
  if (contextId.startsWith("artchat_") || contextId.startsWith("ticketchat_")) return "artifact_chat";
  return "ticket";
}

// =============================================================================
// Types
// =============================================================================

export interface PendingQuestion {
  conversationId: string;
  question: string;
  options: string[] | null;
  askedAt: string;
  phase?: string;
  claudeSessionId?: string;
}

export interface PendingResponse {
  answer: string;
}

// =============================================================================
// Question Operations
// =============================================================================

export function writeQuestion(
  projectId: string,
  contextId: string,
  question: PendingQuestion,
): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO pending_questions
      (project_id, context_id, context_type, conversation_id, question, options, phase, claude_session_id, asked_at, answer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    projectId,
    contextId,
    deriveContextType(contextId),
    question.conversationId,
    question.question,
    question.options ? JSON.stringify(question.options) : null,
    question.phase || null,
    question.claudeSessionId || null,
    question.askedAt,
  );
}

export function readQuestion(
  projectId: string,
  contextId: string,
): PendingQuestion | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT conversation_id, question, options, phase, claude_session_id, asked_at
    FROM pending_questions
    WHERE project_id = ? AND context_id = ?
  `).get(projectId, contextId) as {
    conversation_id: string;
    question: string;
    options: string | null;
    phase: string | null;
    claude_session_id: string | null;
    asked_at: string;
  } | undefined;

  if (!row) return null;

  return {
    conversationId: row.conversation_id,
    question: row.question,
    options: row.options ? JSON.parse(row.options) : null,
    askedAt: row.asked_at,
    ...(row.phase ? { phase: row.phase } : {}),
    ...(row.claude_session_id ? { claudeSessionId: row.claude_session_id } : {}),
  };
}

export function clearQuestion(
  projectId: string,
  contextId: string,
): void {
  const db = getDatabase();
  db.prepare(`
    DELETE FROM pending_questions WHERE project_id = ? AND context_id = ?
  `).run(projectId, contextId);
}

// =============================================================================
// Response Operations
// =============================================================================

export function writeResponse(
  projectId: string,
  contextId: string,
  response: PendingResponse,
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE pending_questions SET answer = ? WHERE project_id = ? AND context_id = ?
  `).run(response.answer, projectId, contextId);
}

export function readResponse(
  projectId: string,
  contextId: string,
): PendingResponse | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT answer FROM pending_questions
    WHERE project_id = ? AND context_id = ? AND answer IS NOT NULL
  `).get(projectId, contextId) as { answer: string } | undefined;

  if (!row) return null;
  return { answer: row.answer };
}

export function clearResponse(
  projectId: string,
  contextId: string,
): void {
  // Deletes the entire row — identical to clearQuestion. Both question and
  // answer live in the same row, so a single DELETE handles full cleanup.
  // Callers don't need to call both clearResponse and clearQuestion.
  const db = getDatabase();
  db.prepare(`
    DELETE FROM pending_questions WHERE project_id = ? AND context_id = ?
  `).run(projectId, contextId);
}

// =============================================================================
// Async Polling
// =============================================================================

/**
 * Wait for a response to be written for the given context.
 *
 * @param projectId - The project ID
 * @param contextId - The context ID (ticket, brainstorm, or artifact chat)
 * @param timeoutMs - Maximum time to wait (default 24 hours)
 * @param signal - Optional AbortSignal to cancel the wait
 * @returns The response answer
 * @throws Error if cancelled or timeout
 */
export async function waitForResponse(
  projectId: string,
  contextId: string,
  timeoutMs: number = 86400000,
  signal?: AbortSignal,
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check for abort
    if (signal?.aborted) {
      throw new Error("Wait cancelled - session replaced");
    }

    const response = readResponse(projectId, contextId);
    if (response) {
      clearResponse(projectId, contextId);
      return response.answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Timeout waiting for response");
}

// =============================================================================
// Scanning
// =============================================================================

export interface PendingContext {
  projectId: string;
  contextId: string;
  type: "ticket" | "brainstorm";
  response: PendingResponse;
  question: PendingQuestion | null;
}

/**
 * Scan all tickets and brainstorms for pending responses that need session resumption.
 */
export function scanPendingResponses(): PendingContext[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT project_id, context_id, context_type, conversation_id, question, options, phase, claude_session_id, asked_at, answer
    FROM pending_questions
    WHERE answer IS NOT NULL AND context_type IN ('ticket', 'brainstorm')
  `).all() as Array<{
    project_id: string;
    context_id: string;
    context_type: string;
    conversation_id: string;
    question: string;
    options: string | null;
    phase: string | null;
    claude_session_id: string | null;
    asked_at: string;
    answer: string;
  }>;

  return rows.map((row) => ({
    projectId: row.project_id,
    contextId: row.context_id,
    type: row.context_type as "ticket" | "brainstorm",
    response: { answer: row.answer },
    question: {
      conversationId: row.conversation_id,
      question: row.question,
      options: row.options ? JSON.parse(row.options) : null,
      askedAt: row.asked_at,
      ...(row.phase ? { phase: row.phase } : {}),
      ...(row.claude_session_id ? { claudeSessionId: row.claude_session_id } : {}),
    },
  }));
}

/**
 * Scan all tickets for pending questions.
 * Returns ticket IDs grouped by project ID.
 * Used by the processing:sync heartbeat to provide authoritative pending state.
 */
export function getPendingQuestionsByProject(): Map<string, string[]> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT project_id, context_id
    FROM pending_questions
    WHERE context_type = 'ticket' AND answer IS NULL
  `).all() as Array<{ project_id: string; context_id: string }>;

  const result = new Map<string, string[]>();
  for (const row of rows) {
    const existing = result.get(row.project_id);
    if (existing) {
      existing.push(row.context_id);
    } else {
      result.set(row.project_id, [row.context_id]);
    }
  }
  return result;
}
