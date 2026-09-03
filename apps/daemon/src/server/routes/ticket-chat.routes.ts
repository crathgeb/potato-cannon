import type { Express, Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { artifactChatStore } from "../../stores/artifact-chat.store.js";
import type { ArtifactChatSession } from "../../stores/artifact-chat.store.js";
import {
  readQuestion,
  writeResponse,
  clearQuestion,
  clearResponse,
} from "../../stores/chat.store.js";
import { listArtifacts, getTicket } from "../../stores/ticket.store.js";
import { addMessage } from "../../stores/conversation.store.js";
import { tryLoadAgentDefinition } from "../../services/session/index.js";
import { runAdhocChatProcess, buildAdhocChatArgs } from "../../services/session/adhoc-chat-runner.js";
import { eventBus } from "../../utils/event-bus.js";
import type { SessionService } from "../../services/session/index.js";
import type { Project } from "../../types/config.types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ticket-wide Q&A - the sibling of artifact-chat, scoped to the ticket as a
// whole rather than one artifact. Added because the ticket's general
// Activity box only ever posted one-way notes when no phase agent was
// running - there was no way for someone reviewing a ticket to actually
// ask about it (status, where evidence lives, why a gate said what it
// said) and get a real answer. Shares the exact same underlying mechanism
// as artifact-chat (adhoc-chat-runner.ts), including the fixes that took
// several rounds to get right there: session registration in the shared
// `sessions` table (needed for --resume), a persistent line buffer across
// PTY read chunks (needed for claude_session_id capture), and a mandatory
// chat_ask requirement in the agent prompt (needed so answers are visible
// to the polling panel instead of silently lost as plain text).
export function registerTicketChatRoutes(
  app: Express,
  sessionService: SessionService,
  getProjects: () => Map<string, Project>
): void {
  // Start ticket chat session
  app.post(
    "/api/ticket-chat/:project/:ticket/start",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.ticket;
        const { message } = req.body as { message?: string };

        if (!message) {
          res.status(400).json({ error: "Missing message" });
          return;
        }

        const projects = getProjects();
        const project = projects.get(projectId);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        const ticket = await getTicket(projectId, ticketId);
        if (!ticket) {
          res.status(404).json({ error: "Ticket not found" });
          return;
        }

        const existingSession = artifactChatStore.getActiveSessionForTicket(
          projectId,
          ticketId
        );
        if (existingSession) {
          res.status(409).json({
            error: "Active session already exists for this ticket",
            contextId: existingSession.contextId,
          });
          return;
        }

        const session = artifactChatStore.createSession(projectId, ticketId);

        const agentDef = await tryLoadAgentDefinition(
          projectId,
          "agents/ticket-qa.md"
        );
        if (!agentDef) {
          artifactChatStore.deleteSession(session.contextId);
          res.status(500).json({ error: "Ticket Q&A agent not found" });
          return;
        }

        const artifacts = await listArtifacts(projectId, ticketId);

        const prompt = buildTicketChatPrompt(
          agentDef.prompt,
          projectId,
          ticketId,
          ticket.title,
          ticket.description || "",
          ticket.phase,
          artifacts,
          message
        );

        // Persist the actual question into the ticket's real conversation -
        // previously it only ever went into the agent's prompt text, never
        // into the saved history. It appeared to work because of the
        // frontend's optimistic local update, then silently vanished the
        // moment the agent's answer arrived and the UI refetched real
        // server-side history: the question was never actually in it.
        persistUserMessage(ticket.conversationId, projectId, ticketId, message);

        await spawnTicketChatSession(session, prompt, project.path, projectId, ticketId);

        res.json({
          sessionId: session.sessionId,
          contextId: session.contextId,
        });
      } catch (error) {
        console.error("[ticket-chat/start] Error:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // Get pending question
  app.get(
    "/api/ticket-chat/:project/:ticket/pending",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const contextId = req.query.contextId as string;

        if (!contextId) {
          res.status(400).json({ error: "Missing contextId" });
          return;
        }

        const session = artifactChatStore.getSession(contextId);
        if (!session) {
          res.json({
            sessionActive: false,
            endReason: "completed",
          });
          return;
        }

        artifactChatStore.updateActivity(contextId);

        const question = readQuestion(projectId, contextId);

        res.json({
          question: question
            ? {
                conversationId: question.conversationId,
                question: question.question,
                options: question.options || undefined,
                askedAt: question.askedAt,
              }
            : undefined,
          sessionActive: session.active,
          endReason: session.endReason,
        });
      } catch (error) {
        console.error("[ticket-chat/pending] Error:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // Send user input (follow-up)
  app.post(
    "/api/ticket-chat/:project/:ticket/input",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const { contextId, message } = req.body as {
          contextId?: string;
          message?: string;
        };

        if (!contextId || !message) {
          res.status(400).json({ error: "Missing contextId or message" });
          return;
        }

        const session = artifactChatStore.getSession(contextId);
        if (!session) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // session.active is expected to be false here on every follow-up -
        // see the identical comment in artifact-chat.routes.ts's /input
        // route, same mechanism, same reasoning.
        const pendingQuestion = readQuestion(projectId, contextId);
        const claudeSessionId = pendingQuestion?.claudeSessionId;
        if (!claudeSessionId) {
          res.status(410).json({
            error: "No resumable session found for this conversation - start a new question instead.",
          });
          return;
        }

        writeResponse(projectId, contextId, { answer: message });
        clearQuestion(projectId, contextId);
        session.active = true;
        session.endReason = undefined;

        const project = getProjects().get(projectId);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        // Same persistence fix as /start - a follow-up needs to be saved
        // into real history too, not just handed to the agent as --print
        // text.
        const ticket = await getTicket(projectId, session.ticketId);
        persistUserMessage(ticket.conversationId, projectId, session.ticketId, message);

        await resumeTicketChatSession(
          session,
          claudeSessionId,
          message,
          project.path,
          projectId,
          session.ticketId
        );

        res.json({ ok: true });
      } catch (error) {
        console.error("[ticket-chat/input] Error:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // End session (called when modal/panel closes)
  app.post(
    "/api/ticket-chat/:project/:ticket/end",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const { contextId } = req.body as { contextId?: string };

        if (!contextId) {
          res.status(400).json({ error: "Missing contextId" });
          return;
        }

        const session = artifactChatStore.getSession(contextId);
        if (session) {
          if (session.active) {
            sessionService.stopSession(session.sessionId);
          }
          try { clearQuestion(projectId, contextId); } catch {}
          try { clearResponse(projectId, contextId); } catch {}
          artifactChatStore.deleteSession(contextId);
        }

        res.json({ ok: true });
      } catch (error) {
        console.error("[ticket-chat/end] Error:", error);
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );
}

function buildTicketChatPrompt(
  agentPrompt: string,
  projectId: string,
  ticketId: string,
  ticketTitle: string,
  ticketDescription: string,
  ticketPhase: string,
  artifacts: Array<{ filename: string; description?: string; type: string }>,
  initialMessage: string
): string {
  const artifactList = artifacts.length
    ? artifacts.map((a) => `- \`${a.filename}\` (${a.type})${a.description ? ` - ${a.description}` : ""}`).join("\n")
    : "(no artifacts attached yet)";

  return `${agentPrompt}

---

## Context

**Project:** ${projectId}
**Ticket:** ${ticketId}
**Title:** ${ticketTitle}
**Current phase:** ${ticketPhase}
${ticketDescription ? `**Description:** ${ticketDescription}` : ""}

## Artifacts attached to this ticket

${artifactList}

Use \`get_artifact\`/\`list_artifacts\` to read any of the above when the question needs it - don't guess at their contents from the filename/description alone.

## User's Question

${initialMessage}

---

Begin by answering the user's question about this ticket.`;
}

function buildTicketChatMcpConfig(projectId: string, ticketId: string, contextId: string) {
  const mcpProxyPath = path.join(__dirname, "..", "..", "mcp", "proxy.js");
  return {
    mcpServers: {
      "potato-cannon": {
        command: "node",
        args: [mcpProxyPath],
        env: {
          POTATO_PROJECT_ID: projectId,
          POTATO_TICKET_ID: ticketId,
          POTATO_BRAINSTORM_ID: contextId, // Use contextId for chat routing
        },
      },
    },
  };
}

async function spawnTicketChatSession(
  session: ArtifactChatSession,
  prompt: string,
  projectPath: string,
  projectId: string,
  ticketId: string
): Promise<void> {
  const meta = {
    projectId,
    ticketId,
    ticketChat: true,
    contextId: session.contextId,
    startedAt: new Date().toISOString(),
    status: "running" as const,
  };

  const mcpConfig = buildTicketChatMcpConfig(projectId, ticketId, session.contextId);
  const args = buildAdhocChatArgs(mcpConfig, prompt);
  runAdhocChatProcess(session, args, projectPath, projectId, ticketId, "ticket-qa", meta);
}

async function resumeTicketChatSession(
  session: ArtifactChatSession | undefined,
  claudeSessionId: string,
  message: string,
  projectPath: string,
  projectId: string,
  ticketId: string
): Promise<void> {
  if (!session) return;

  const meta = {
    projectId,
    ticketId,
    ticketChat: true,
    contextId: session.contextId,
    resumedAt: new Date().toISOString(),
    status: "running" as const,
  };

  const mcpConfig = buildTicketChatMcpConfig(projectId, ticketId, session.contextId);
  const args = buildAdhocChatArgs(mcpConfig, message, claudeSessionId);

  artifactChatStore.updateActivity(session.contextId);
  runAdhocChatProcess(session, args, projectPath, projectId, ticketId, "ticket-qa", meta);
}

// Saves the user's actual typed message into the ticket's real conversation
// and emits the same event the general ticket box's /comments route does,
// so it shows up immediately via the existing useTicketMessage SSE
// subscription in ActivityTab - not just as text handed to the agent.
function persistUserMessage(
  conversationId: string | undefined,
  projectId: string,
  ticketId: string,
  message: string
): void {
  if (!conversationId) return;
  const saved = addMessage(conversationId, { type: "user", text: message });
  eventBus.emit("ticket:message", {
    projectId,
    ticketId,
    message: { type: "user", text: saved.text, timestamp: saved.timestamp },
  });
}
