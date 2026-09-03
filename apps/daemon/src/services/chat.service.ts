// src/services/chat.service.ts

import type {
  ChatProvider,
  ChatContext,
  OutboundMessage,
  ProviderThreadInfo,
} from "../providers/chat-provider.types.js";
import {
  getProviderThread,
  setProviderThread,
  getAllThreads,
} from "../stores/chat-threads.store.js";
import {
  writeQuestion,
  readResponse,
  clearQuestion,
  clearResponse,
  waitForResponse,
  writeResponse,
  createWaitController,
} from "../stores/chat.store.js";
import { appendTicketLog } from "../stores/ticket-log.store.js";
import { eventBus } from "../utils/event-bus.js";
import {
  addMessage,
  answerQuestion,
  getPendingQuestion,
} from "../stores/conversation.store.js";
import { getDatabase } from "../stores/db.js";
import { getActiveSessionForTicket } from "../stores/session.store.js";
import { artifactChatStore } from "../stores/artifact-chat.store.js";

export class ChatService {
  private providers: Map<string, ChatProvider> = new Map();
  private pendingOptions: Map<string, string[]> = new Map();

  // Idempotency cache to prevent duplicate question broadcasts
  private recentQuestions: Map<string, { hash: string; timestamp: number }> = new Map();
  private readonly IDEMPOTENCY_WINDOW_MS = 30000; // 30 seconds

  registerProvider(provider: ChatProvider): void {
    this.providers.set(provider.id, provider);
    console.log(`[ChatService] Registered provider: ${provider.name}`);
  }

  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
  }

  getProvider(id: string): ChatProvider | null {
    return this.providers.get(id) || null;
  }

  getActiveProviders(): ChatProvider[] {
    return Array.from(this.providers.values());
  }

  async initChat(context: ChatContext, title: string): Promise<void> {
    const providers = this.getActiveProviders();

    if (providers.length === 0) {
      console.log("[ChatService] No providers configured, skipping chat init");
      return;
    }

    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        const existing = await getProviderThread(context, provider.id);
        if (existing) return existing;

        const thread = await provider.createThread(context, title);
        await setProviderThread(context, thread);
        return thread;
      }),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.warn(
        `[ChatService] Some providers failed to init chat:`,
        failures.map((f) => (f as PromiseRejectedResult).reason),
      );
    }
  }

  async ask(
    context: ChatContext,
    question: string,
    options?: string[],
    phase?: string,
  ): Promise<string> {
    const providers = this.getActiveProviders();
    const contextKey = this.getContextKey(context);
    const contextId = this.getContextId(context);
    const now = new Date().toISOString();

    // Create abort controller for this wait - allows session termination to cancel
    const controller = createWaitController(contextId);

    // Skip if duplicate within idempotency window
    if (this.isDuplicateQuestion(contextKey, question)) {
      // Still need to wait for response (from the original ask)
      try {
        return await waitForResponse(context.projectId, contextId, undefined, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          console.log(`[ChatService] Wait cancelled for duplicate ${contextId} - session replaced`);
          throw error; // Re-throw to signal cancellation to caller
        }
        throw error;
      }
    }

    // Store options for potential number-to-option mapping
    if (options && options.length > 0) {
      this.pendingOptions.set(contextKey, options);
    }

    // Get conversation ID from the entity
    const conversationId = this.getConversationId(context);

    // Add question message to conversation store (if we have a conversation)
    let questionMessageId: string | undefined;
    if (conversationId) {
      const adhocMeta = this.getAdhocChatMetadata(context);
      const metadata = phase || adhocMeta ? { ...(phase ? { phase } : {}), ...adhocMeta } : undefined;
      const message = addMessage(conversationId, {
        type: "question",
        text: question,
        options,
        metadata,
      });
      questionMessageId = message.id;
    }

    // Write pending question for MCP sync (allows web UI to poll)
    writeQuestion(context.projectId, contextId, {
      conversationId: questionMessageId || this.generateConversationId(),
      question,
      options: options || null,
      askedAt: now,
      phase,
    });

    // Log the question being sent
    const truncatedQuestion =
      question.length > 50 ? question.substring(0, 50) + "..." : question;
    console.log(
      `[ChatService] Sending question for ${contextId}: ${truncatedQuestion}`,
    );

    // Also log to ticket-specific log file
    if (context.ticketId) {
      await appendTicketLog(
        context.projectId,
        context.ticketId,
        `[Question] ${truncatedQuestion}`,
      );
    }

    // Emit events for real-time updates. adhoc marks this as coming from
    // an artifact-chat/ticket-chat Q&A session rather than a real
    // phase-agent question - the frontend's "yellow ? badge" (isPending)
    // is meant for "the ticket's own workflow is genuinely blocked on
    // you," which is not true for these; they don't block anything, and
    // the badge previously only cleared on a type:'user' reply, so simply
    // reading the answer and moving on left it stuck lit forever.
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "question", text: question, options, timestamp: now, adhoc: !!this.getAdhocChatMetadata(context) },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "question", text: question, options, timestamp: now },
      });
    }

    // Broadcast to providers if any are configured
    if (providers.length > 0) {
      const message: OutboundMessage = { text: question, options, phase };
      const results = await Promise.allSettled(
        providers.map((p) => this.sendToProvider(p, context, message)),
      );

      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.warn(
          `[ChatService] Some providers failed:`,
          failures.map((f) => (f as PromiseRejectedResult).reason),
        );
      }
    }

    // Wait for response (from web UI or any provider)
    let answer: string;
    try {
      answer = await waitForResponse(context.projectId, contextId, undefined, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[ChatService] Wait cancelled for ${contextId} - session replaced`);
        // Clean up pending options
        this.pendingOptions.delete(contextKey);
        throw error; // Re-throw to signal cancellation to caller
      }
      throw error;
    }

    // Map numbered response back to option if applicable
    const mappedAnswer = this.mapNumberedResponse(contextKey, answer);
    this.pendingOptions.delete(contextKey);

    // Mark question as answered and add user response
    if (conversationId) {
      if (questionMessageId) {
        answerQuestion(questionMessageId);
      }
      addMessage(conversationId, {
        type: "user",
        text: mappedAnswer,
      });
    }

    // Emit event so frontend can update with the user message
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "user", text: mappedAnswer, timestamp: now },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "user", text: mappedAnswer, timestamp: now },
      });
    }

    return mappedAnswer;
  }

  /**
   * Async version of ask() for brainstorms.
   * Saves question and returns immediately without waiting for response.
   * The session is expected to exit, and a new session will be spawned when user responds.
   */
  async askAsync(
    context: ChatContext,
    question: string,
    options?: string[],
    phase?: string,
  ): Promise<{ status: 'pending'; questionId: string }> {
    const contextKey = this.getContextKey(context);
    const contextId = this.getContextId(context);
    const now = new Date().toISOString();

    // Store options for potential number-to-option mapping on response
    if (options && options.length > 0) {
      this.pendingOptions.set(contextKey, options);
    }

    // Get conversation ID from the entity
    const conversationId = this.getConversationId(context);

    // Add question message to conversation store
    let questionMessageId: string = '';
    if (conversationId) {
      const adhocMeta = this.getAdhocChatMetadata(context);
      const metadata = phase || adhocMeta ? { ...(phase ? { phase } : {}), ...adhocMeta } : undefined;
      const message = addMessage(conversationId, {
        type: "question",
        text: question,
        options,
        metadata,
      });
      questionMessageId = message.id;
    }

    // Look up the active session's claude_session_id for ticket contexts
    // so resumeSuspendedTicket can use it directly instead of a fragile "latest" lookup.
    let claudeSessionId: string | undefined;
    if (context.ticketId) {
      const activeSession = getActiveSessionForTicket(context.ticketId);
      claudeSessionId = activeSession?.claudeSessionId;
    }

    // Write pending question for IPC (allows session respawn to inject response)
    writeQuestion(context.projectId, contextId, {
      conversationId: questionMessageId || this.generateConversationId(),
      question,
      options: options || null,
      askedAt: now,
      phase,
      ...(claudeSessionId ? { claudeSessionId } : {}),
    });

    // Log the question
    const truncatedQuestion =
      question.length > 50 ? question.substring(0, 50) + "..." : question;
    console.log(
      `[ChatService] askAsync - question saved for ${contextId}: ${truncatedQuestion}`,
    );

    // Emit SSE events for frontend - see the identical comment on the
    // matching emit in ask() above for why `adhoc` exists.
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "question", text: question, options, timestamp: now, adhoc: !!this.getAdhocChatMetadata(context) },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "question", text: question, options, timestamp: now },
      });
    }
    if (context.epicId) {
      eventBus.emit("epic:message", {
        projectId: context.projectId,
        epicId: context.epicId,
        message: { type: "question", text: question, options, timestamp: now, conversationId: questionMessageId },
      });
    }

    // Broadcast to providers (Telegram, Slack, etc.)
    const providers = this.getActiveProviders();
    if (providers.length > 0) {
      const message: OutboundMessage = { text: question, options, phase };
      const results = await Promise.allSettled(
        providers.map((p) => this.sendToProvider(p, context, message)),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "rejected") {
          console.warn(
            `[ChatService] Failed to send question via ${providers[i].id}:`,
            r.reason,
          );
        }
      }
    }

    // Return immediately - don't wait for response
    return { status: 'pending', questionId: questionMessageId };
  }

  async notify(context: ChatContext, message: string): Promise<void> {
    const now = new Date().toISOString();

    // Get conversation ID and persist notification
    const conversationId = this.getConversationId(context);
    if (conversationId) {
      addMessage(conversationId, {
        type: "notification",
        text: message,
      });
    }

    // Emit events for real-time updates
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "notification", text: message, timestamp: now },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "notification", text: message, timestamp: now },
      });
    }
    if (context.epicId) {
      eventBus.emit("epic:message", {
        projectId: context.projectId,
        epicId: context.epicId,
        message: { type: "notification", text: message, timestamp: now },
      });
    }

    const providers = this.getActiveProviders();

    if (providers.length === 0) {
      console.log(
        "[ChatService] No providers configured, skipping notification",
      );
      return;
    }

    const outbound: OutboundMessage = { text: message };

    const results = await Promise.allSettled(
      providers.map((p) => this.sendToProvider(p, context, outbound)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        console.warn(
          `[ChatService] Failed to send notification via ${providers[i].id}:`,
          r.reason,
        );
      }
    }
  }

  async handleResponse(
    providerId: string,
    context: ChatContext,
    answer: string,
  ): Promise<boolean> {
    // Check if question is still pending
    const response = readResponse(
      context.projectId,
      this.getContextId(context),
    );
    if (response) {
      // Already answered
      return false;
    }

    // Write response
    writeResponse(context.projectId, this.getContextId(context), {
      answer,
    });

    // All contexts use async askAsync flow — save user message to conversation store here.
    const conversationId = this.getConversationId(context);
    if (conversationId) {
      const pendingQuestion = getPendingQuestion(conversationId);
      if (pendingQuestion) {
        answerQuestion(pendingQuestion.id);
        addMessage(conversationId, {
          type: "user",
          text: answer,
        });

        if (context.brainstormId) {
          eventBus.emit("brainstorm:message", {
            projectId: context.projectId,
            brainstormId: context.brainstormId,
            message: { type: "user", text: answer, timestamp: new Date().toISOString() },
          });
        }
        if (context.epicId) {
          eventBus.emit("epic:message", {
            projectId: context.projectId,
            epicId: context.epicId,
            message: { type: "user", text: answer, timestamp: new Date().toISOString() },
          });
        }
        if (context.ticketId) {
          eventBus.emit("ticket:message", {
            projectId: context.projectId,
            ticketId: context.ticketId,
            message: { type: "user", text: answer, timestamp: new Date().toISOString() },
          });
        }
      }
    }

    // Notify other providers
    const providers = this.getActiveProviders().filter(
      (p) => p.id !== providerId,
    );
    await Promise.allSettled(
      providers.map(async (p) => {
        const thread = await getProviderThread(context, p.id);
        if (thread) {
          await p.notifyAnswered(thread, answer);
        }
      }),
    );

    return true;
  }

  private async sendToProvider(
    provider: ChatProvider,
    context: ChatContext,
    message: OutboundMessage,
  ): Promise<void> {
    const contextId = context.ticketId || context.brainstormId || "unknown";
    let thread = await getProviderThread(context, provider.id);

    if (!thread) {
      const title = context.ticketId || context.brainstormId || "Chat";
      console.log(`[ChatService] Creating ${provider.id} thread for ${contextId}`);
      thread = await provider.createThread(context, title);
      await setProviderThread(context, thread);
      console.log(`[ChatService] Created ${provider.id} thread for ${contextId}`);
    }

    // Degrade buttons to numbered text if provider doesn't support them
    let finalMessage = message;
    if (message.options && !provider.capabilities.buttons) {
      const numberedOptions = message.options
        .map((opt, i) => `${i + 1}. ${opt}`)
        .join("\n");
      finalMessage = {
        ...message,
        text: `${message.text}\n\n${numberedOptions}\n\nReply with a number.`,
        options: undefined,
      };
    }

    await provider.send(thread, finalMessage);
    console.log(`[ChatService] Sent message via ${provider.id} for ${contextId}`);
  }

  private mapNumberedResponse(contextKey: string, answer: string): string {
    const options = this.pendingOptions.get(contextKey);
    if (!options) return answer;

    const trimmed = answer.trim();
    const num = parseInt(trimmed, 10);

    if (!isNaN(num) && num >= 1 && num <= options.length) {
      return options[num - 1];
    }

    return answer;
  }

  // brainstormId is checked before ticketId deliberately. Every normal
  // ticket-phase session hardcodes brainstormId to "" (session.service.ts),
  // so this ordering is a no-op for them either way. The one case where both
  // are simultaneously non-empty is artifact-chat (artifact-chat.routes.ts
  // sets POTATO_TICKET_ID *and* POTATO_BRAINSTORM_ID: session.contextId, by
  // design, per that file's own comment "Use contextId for chat routing") -
  // ticketId-first silently broke that routing, sending the artifact chat's
  // answer to the ticket's own pending-question slot instead of its own.
  private getContextKey(context: ChatContext): string {
    return `${context.projectId}:${context.brainstormId || context.ticketId || context.epicId}`;
  }

  private getContextId(context: ChatContext): string {
    return context.brainstormId || context.ticketId || context.epicId || "";
  }

  private generateConversationId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `conv_${timestamp}_${random}`;
  }

  // Artifact-chat and ticket-chat sessions both write into the same shared
  // ticket conversation (getConversationId resolves by ticketId, and both
  // session types always carry a real one) - so a question asked from
  // "Ask about this artifact" was indistinguishable from a general
  // ticket-level question once saved, and the artifact panel (which has no
  // persistence of its own - see ArtifactChat.tsx) had no way to recover
  // its own history on reopen. Tagging the message with which artifact (if
  // any) the session is scoped to lets the panel fetch and filter by it.
  private getAdhocChatMetadata(context: ChatContext): Record<string, unknown> | undefined {
    if (!context.brainstormId) return undefined;
    const session = artifactChatStore.getSession(context.brainstormId);
    if (!session) return undefined;
    return session.artifactFilename
      ? { artifactFilename: session.artifactFilename }
      : { ticketChat: true };
  }

  private getConversationId(context: ChatContext): string | null {
    const db = getDatabase();

    if (context.ticketId) {
      const row = db
        .prepare("SELECT conversation_id FROM tickets WHERE id = ?")
        .get(context.ticketId) as { conversation_id: string | null } | undefined;
      return row?.conversation_id || null;
    }

    if (context.brainstormId) {
      const row = db
        .prepare("SELECT conversation_id FROM brainstorms WHERE id = ?")
        .get(context.brainstormId) as { conversation_id: string | null } | undefined;
      return row?.conversation_id || null;
    }

    if (context.epicId) {
      const row = db
        .prepare("SELECT conversation_id FROM epics WHERE id = ?")
        .get(context.epicId) as { conversation_id: string | null } | undefined;
      return row?.conversation_id || null;
    }

    return null;
  }

  /**
   * Check if this question was recently asked for this context.
   * Returns true if duplicate (should skip), false if new.
   */
  private isDuplicateQuestion(contextKey: string, question: string): boolean {
    const hash = this.hashQuestion(question);
    const recent = this.recentQuestions.get(contextKey);

    // Clean old entries periodically
    this.cleanOldEntries();

    if (recent && recent.hash === hash) {
      const age = Date.now() - recent.timestamp;
      if (age < this.IDEMPOTENCY_WINDOW_MS) {
        console.log(`[ChatService] Skipping duplicate question for ${contextKey}`);
        return true;
      }
    }

    this.recentQuestions.set(contextKey, { hash, timestamp: Date.now() });
    return false;
  }

  /**
   * Create a simple hash of the question for comparison.
   */
  private hashQuestion(question: string): string {
    // Simple hash - first 100 chars + length
    return `${question.substring(0, 100)}:${question.length}`;
  }

  /**
   * Clean up old entries from the idempotency cache.
   */
  private cleanOldEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.recentQuestions) {
      if (now - entry.timestamp > this.IDEMPOTENCY_WINDOW_MS * 2) {
        this.recentQuestions.delete(key);
      }
    }
  }
}

// Singleton instance
export const chatService = new ChatService();
