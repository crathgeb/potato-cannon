import express, { Express } from "express";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { lock } from "proper-lockfile";

import { DEFAULT_PORT, DEFAULT_HOST } from "@potato-cannon/shared";
import { eventBus } from "../utils/event-bus.js";
import { formatListenUrls } from "../utils/listen-urls.js";
import { Logger } from "../utils/logger.js";
import { SessionService } from "../services/session/index.js";
import { setupWipDrainListener } from "../services/session/wip.js";
import { chatService } from "../services/chat.service.js";
import { TelegramProvider } from "../providers/telegram/telegram.provider.js";
import { SlackProvider } from "../providers/slack/slack.provider.js";
import {
  registerProjectRoutes,
  registerTicketRoutes,
  registerSessionRoutes,
  registerBrainstormRoutes,
  registerTelegramRoutes,
  registerMcpRoutes,
  registerTemplateRoutes,
  registerTaskRoutes,
  registerRalphRoutes,
  registerArtifactChatRoutes,
  registerTicketChatRoutes,
  registerFolderRoutes,
  registerEpicRoutes,
  refreshProjects,
  getProjects,
} from "./routes/index.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  ensureGlobalDir,
  writePid,
  removePid,
  writeDaemonInfo,
  removeDaemonInfo,
} from "../stores/config.store.js";
import { initDatabase, closeDatabase } from "../stores/db.js";
import { updateProjectTemplate } from "../stores/project.store.js";
import { installDefaultTemplates } from "../stores/template.store.js";
import {
  hasProjectTemplate,
  copyTemplateToProject,
} from "../stores/project-template.store.js";
import { bootstrapMarketplace } from "../marketplace/bootstrap.js";
import {
  getTicket,
  updateTicket,
  isTerminalPhase,
  listTickets,
} from "../stores/ticket.store.js";
import { getBrainstorm, updateBrainstorm } from "../stores/brainstorm.store.js";
import {
  endStoredSession,
  createStoredSession,
  getActiveSessionForTicket,
  getActiveSessionForBrainstorm,
} from "../stores/session.store.js";
import { scanPendingResponses, clearQuestion, clearResponse, readQuestion, getPendingQuestionsByProject } from "../stores/chat.store.js";
import { artifactChatStore } from "../stores/artifact-chat.store.js";
import { SESSIONS_DIR, LOCK_FILE, PID_FILE, TASKS_DIR } from "../config/paths.js";
import type { GlobalConfig, Project } from "../types/config.types.js";
import { getWorkerState, clearWorkerState } from "../services/session/worker-state.js";
import { getPhaseConfig } from "../services/session/phase-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let globalConfig: GlobalConfig | null = null;
let server: ReturnType<Express["listen"]> | null = null;
let sessionService: SessionService | null = null;
let telegramProvider: TelegramProvider | null = null;
let telegramMode = "none";
let slackProvider: SlackProvider | null = null;

/**
 * Acquire an exclusive lock to ensure only one daemon runs at a time.
 * Exits with error if another daemon is already running.
 */
async function acquireDaemonLock(): Promise<void> {
  // Ensure global directory exists before creating lock file
  await ensureGlobalDir();

  // Ensure lock file exists
  await fs.writeFile(LOCK_FILE, "", { flag: "a" });

  try {
    await lock(LOCK_FILE, { stale: 10000 }); // 10s stale threshold
  } catch (err) {
    // Lock held by another process - read PID file for helpful error
    const existingPid = await fs
      .readFile(PID_FILE, "utf-8")
      .catch(() => "unknown");
    console.error(
      `Daemon already running (PID ${existingPid.trim()}). Exiting.`,
    );
    process.exit(1);
  }
}

async function loadConfig(): Promise<GlobalConfig> {
  globalConfig = await loadGlobalConfig();
  if (!globalConfig) {
    console.log("First run detected. Creating default config...");
    await ensureGlobalDir();
    globalConfig = {
      telegram: { botToken: "", userId: "", mode: "auto" },
      daemon: { port: DEFAULT_PORT },
    };
    await saveGlobalConfig(globalConfig);
  }
  return globalConfig;
}

/**
 * Recover orphaned sessions on startup.
 */
async function recoverOrphanedSessions(): Promise<void> {
  let files: string[];
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    return;
  }

  const sessionFiles = files.filter((f) => f.endsWith(".jsonl"));
  let recovered = 0;

  for (const file of sessionFiles) {
    const filePath = path.join(SESSIONS_DIR, file);
    const sessionId = file.replace(".jsonl", "");

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((l) => l);

      if (lines.length === 0) continue;

      const lastLine = JSON.parse(lines[lines.length - 1]);
      if (lastLine.type === "session_end") continue;

      const firstLine = JSON.parse(lines[0]);
      if (firstLine.type !== "session_start") continue;

      const { projectId, ticketId } = firstLine.meta || {};
      if (!projectId || !ticketId) continue;

      const ended = endStoredSession(sessionId, -1);
      if (ended) {
        console.log(
          `[recovery] Marked orphaned session ${sessionId} as ended for ${ticketId}`,
        );
        recovered++;

        const endEntry = {
          type: "session_end",
          meta: {
            ...firstLine.meta,
            status: "interrupted",
            exitCode: -1,
            endedAt: new Date().toISOString(),
            recoveredAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        };
        await fs.appendFile(filePath, JSON.stringify(endEntry) + "\n");
      }
    } catch (err) {
      console.error(
        `[recovery] Error processing ${file}: ${(err as Error).message}`,
      );
    }
  }

  if (recovered > 0) {
    console.log(`[recovery] Recovered ${recovered} orphaned session(s)`);
  }
}

/**
 * Reconcile ticket history with session log files.
 * Finds tickets that claim to have active sessions but the session actually ended.
 * This handles cases where the ticket JSON wasn't updated when a session ended
 * (e.g., due to file corruption or race conditions).
 */
async function reconcileTicketSessions(): Promise<void> {
  const projects = getProjects();
  let reconciled = 0;

  for (const [projectId] of projects) {
    let tickets;
    try {
      tickets = await listTickets(projectId);
    } catch {
      continue;
    }

    // Sessions are now tracked in the sessions table - legacy reconciliation not needed
  }

  if (reconciled > 0) {
    console.log(`[recovery] Reconciled ${reconciled} stale session(s)`);
  }
}

/**
 * Resume sessions for tickets/brainstorms that have pending responses but no active session.
 * This handles the case where the daemon was restarted while waiting for a user response.
 */
async function recoverPendingResponses(): Promise<void> {
  if (!sessionService) return;

  const pending = scanPendingResponses();
  if (pending.length === 0) return;

  console.log(
    `[recovery] Found ${pending.length} pending response(s) to process`,
  );
  const projects = getProjects();

  for (const item of pending) {
    const project = projects.get(item.projectId);
    if (!project) {
      console.log(
        `[recovery] Project ${item.projectId} not registered, skipping ${item.contextId}`,
      );
      continue;
    }

    try {
      if (item.type === "ticket") {
        const ticket = await getTicket(item.projectId, item.contextId);
        if (!ticket) {
          console.log(
            `[recovery] Ticket ${item.contextId} not found, skipping`,
          );
          continue;
        }

        // Skip terminal phases
        if (isTerminalPhase(ticket.phase)) {
          console.log(
            `[recovery] Ticket ${item.contextId} is in terminal phase ${ticket.phase}, cleaning up stale pending files`,
          );
          clearQuestion(item.projectId, item.contextId);
          clearResponse(item.projectId, item.contextId);
          continue;
        }

        // Check if this was a suspended session (has both pending question and response)
        if (item.question) {
          // Suspended session — resume with --resume flag
          try {
            const newSessionId = await sessionService.resumeSuspendedTicket(
              item.projectId,
              item.contextId,
              item.response.answer,
            );
            console.log(
              `[recovery] Resumed suspended session ${newSessionId} for ticket ${item.contextId}`,
            );
          } catch (err) {
            console.error(
              `[recovery] Failed to resume suspended ticket ${item.contextId}: ${(err as Error).message}`,
            );
            // Fall back to standard recovery
            const sessionId = await sessionService.spawnForTicket(
              item.projectId,
              item.contextId,
              ticket.phase,
              project.path,
            );
            console.log(
              `[recovery] Fallback: spawned session ${sessionId} for ticket ${item.contextId}`,
            );
          }
        } else {
          // Standard recovery — no pending question means it was a blocking ask
          const sessionId = await sessionService.spawnForTicket(
            item.projectId,
            item.contextId,
            ticket.phase,
            project.path,
          );
          await updateTicket(item.projectId, item.contextId, { sessionId });
          console.log(
            `[recovery] Spawned session ${sessionId} for ticket ${item.contextId}`,
          );
        }
      } else {
        const brainstorm = await getBrainstorm(item.projectId, item.contextId);
        if (!brainstorm) {
          console.log(
            `[recovery] Brainstorm ${item.contextId} not found, skipping`,
          );
          continue;
        }

        const sessionId = await sessionService.spawnForBrainstorm(
          item.projectId,
          item.contextId,
          project.path,
        );
        // Session is tracked in sessions table, no need to update brainstorm
        console.log(
          `[recovery] Spawned session ${sessionId} for brainstorm ${item.contextId}`,
        );
      }
    } catch (err) {
      console.error(
        `[recovery] Failed to spawn session for ${item.contextId}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Recover tickets that were interrupted mid-execution.
 * Finds tickets with worker-state.json files indicating in-progress work
 * but no active session, and restarts them.
 */
async function recoverInterruptedSessions(): Promise<void> {
  if (!sessionService) return;

  const projects = getProjects();
  let recovered = 0;

  for (const [projectId, project] of projects) {
    let ticketDirs: string[];
    try {
      const safeProjectId = projectId.replace(/\//g, "__");
      const projectTicketsDir = path.join(TASKS_DIR, safeProjectId);
      ticketDirs = await fs.readdir(projectTicketsDir);
    } catch {
      continue;
    }

    for (const ticketId of ticketDirs) {
      try {
        // Check if ticket has worker state
        const workerState = await getWorkerState(projectId, ticketId);
        if (!workerState) continue;

        // Get the ticket to check its phase
        const ticket = await getTicket(projectId, ticketId);
        if (!ticket) {
          // Ticket doesn't exist anymore - clean up stale state
          console.log(
            `[recovery] Ticket ${ticketId} not found, clearing stale worker state`,
          );
          await clearWorkerState(projectId, ticketId);
          continue;
        }

        // Skip terminal phases
        if (isTerminalPhase(ticket.phase)) {
          console.log(
            `[recovery] Ticket ${ticketId} is in terminal phase ${ticket.phase}, clearing stale worker state`,
          );
          await clearWorkerState(projectId, ticketId);
          continue;
        }

        // Check if phase has workers (automation)
        const phaseConfig = await getPhaseConfig(projectId, ticket.phase);
        if (!phaseConfig?.workers || phaseConfig.workers.length === 0) {
          console.log(
            `[recovery] Ticket ${ticketId} phase ${ticket.phase} has no workers, clearing stale worker state`,
          );
          await clearWorkerState(projectId, ticketId);
          continue;
        }

        // Check if ticket already has an active session
        if (getActiveSessionForTicket(ticketId)) {
          // Session might still be running or was already recovered
          continue;
        }

        // Spawn session to resume
        console.log(
          `[recovery] Resuming interrupted ticket ${ticketId} in phase ${ticket.phase}`,
        );
        const sessionId = await sessionService.spawnForTicket(
          projectId,
          ticketId,
          ticket.phase,
          project.path,
        );
        // Session is tracked in sessions table, no need to update ticket
        console.log(
          `[recovery] Spawned session ${sessionId} to resume ticket ${ticketId}`,
        );
        recovered++;
      } catch (err) {
        console.error(
          `[recovery] Error checking ticket ${ticketId}: ${(err as Error).message}`,
        );
      }
    }
  }

  if (recovered > 0) {
    console.log(`[recovery] Resumed ${recovered} interrupted session(s)`);
  }
}

/**
 * Migrate existing projects to local template copies.
 * Projects with a template assigned but no local copy get one created.
 */
async function migrateProjectTemplates(): Promise<void> {
  const projects = getProjects();
  let migrated = 0;

  for (const [projectId, project] of projects) {
    if (!project.template) continue;

    try {
      if (!(await hasProjectTemplate(projectId))) {
        const copied = await copyTemplateToProject(projectId, project.template.name);
        await updateProjectTemplate(projectId, project.template.name, copied.version);
        console.log(`[migration] Migrated template for project ${projectId}`);
        migrated++;
      }
    } catch (err) {
      console.error(`[migration] Failed to migrate template for ${projectId}: ${(err as Error).message}`);
    }
  }

  if (migrated > 0) {
    console.log(`[migration] Migrated ${migrated} project(s) to local templates`);
  }
}

export async function main(): Promise<void> {
  // Ensure only one daemon runs at a time
  await acquireDaemonLock();

  const logger = new Logger();
  await logger.init();

  console.log("Potato Cannon Dashboard Starting...\n");

  await loadConfig();
  await ensureGlobalDir();

  // Initialize database (must be before refreshProjects)
  initDatabase();

  await refreshProjects();

  await installDefaultTemplates();
  await migrateProjectTemplates();
  await bootstrapMarketplace();
  await recoverOrphanedSessions();
  await reconcileTicketSessions();
  artifactChatStore.clearAll();
  artifactChatStore.startCleanupTimer();

  const projects = getProjects();
  console.log(`Loaded ${projects.size} registered project(s)`);

  sessionService = new SessionService(eventBus as EventEmitter);
  setupWipDrainListener(sessionService);

  // Session events - sessions are tracked in the sessions table by SessionService
  eventBus.on(
    "session:started",
    async (data: {
      sessionId: string;
      projectId: string;
      ticketId?: string;
      agentType?: string;
    }) => {
      const { sessionId, projectId, ticketId, agentType } = data;
      if (!projectId || !ticketId) return;

      console.log(
        `[session:started] Session ${sessionId} (${agentType || "unknown"}) started for ticket ${ticketId}`,
      );
      // Emit ticket update so frontend knows it's processing
      try {
        const ticket = await getTicket(projectId, ticketId);
        eventBus.emit("ticket:updated", { projectId, ticket });
      } catch {
        // Ignore
      }
    },
  );

  eventBus.on(
    "session:ended",
    async (data: {
      sessionId: string;
      projectId: string;
      ticketId?: string;
      brainstormId?: string;
      exitCode?: number;
    }) => {
      const { sessionId, projectId, ticketId, brainstormId, exitCode } = data;

      // Handle ticket session end
      if (projectId && ticketId) {
        console.log(
          `[session:ended] Session ${sessionId} ended for ticket ${ticketId} with exit code ${exitCode}`,
        );
        try {
          const ticket = await getTicket(projectId, ticketId);
          eventBus.emit("ticket:updated", { projectId, ticket });
        } catch {
          // Ignore
        }
      }

      // Handle brainstorm session end
      if (projectId && brainstormId) {
        console.log(
          `[session:ended] Session ${sessionId} ended for brainstorm ${brainstormId} with exit code ${exitCode}`,
        );
        try {
          const stillActive = getActiveSessionForBrainstorm(brainstormId);
          const pendingQuestion = readQuestion(projectId, brainstormId);

          if (!stillActive && !pendingQuestion) {
            const brainstorm = await updateBrainstorm(projectId, brainstormId, {
              status: 'completed',
            });
            if (brainstorm) {
              eventBus.emit('brainstorm:updated', { projectId, brainstorm });
            }
          }
        } catch {
          // Ignore - brainstorm may have been deleted
        }
      }
    },
  );

  // Processing sync heartbeat - broadcasts currently processing sessions every 5 seconds
  // This ensures frontend stays in sync even if SSE events are missed
  setInterval(async () => {
    if (!sessionService) return;
    const processingByProject = sessionService.getProcessingByProject();
    const pendingByProject = getPendingQuestionsByProject();

    // Collect all project IDs from both maps
    const allProjectIds = new Set([
      ...processingByProject.keys(),
      ...pendingByProject.keys(),
    ]);

    for (const projectId of allProjectIds) {
      const processing = processingByProject.get(projectId);
      const pendingTicketIds = pendingByProject.get(projectId) ?? [];
      eventBus.emit("processing:sync", {
        projectId,
        ticketIds: processing?.ticketIds ?? [],
        brainstormIds: processing?.brainstormIds ?? [],
        pendingTicketIds,
      });
    }
  }, 5000);

  // TelegramProvider will be initialized after server starts if configured

  const app = express();
  app.use(express.json());
  app.use(express.text({ type: "text/plain" }));

  // In development, frontend runs on Vite dev server (port 5173)
  // In production, serve the built frontend from the frontend package
  // Path differs between monorepo build and Electron bundle
  let frontendDist: string | null = null;
  if (process.env.NODE_ENV !== 'development') {
    // Electron passes the frontend path explicitly via env var
    const envPath = process.env.POTATO_FRONTEND_DIST;
    // Try monorepo path: apps/daemon/dist/server -> apps/frontend/dist
    const monorepoPath = path.join(__dirname, '..', '..', '..', 'frontend', 'dist');
    // Electron bundle path: Resources/daemon/dist/server -> Resources/frontend
    const electronPath = path.join(__dirname, '..', '..', '..', 'frontend');

    if (envPath && existsSync(path.join(envPath, 'index.html'))) {
      frontendDist = envPath;
    } else if (existsSync(path.join(monorepoPath, 'index.html'))) {
      frontendDist = monorepoPath;
    } else if (existsSync(path.join(electronPath, 'index.html'))) {
      frontendDist = electronPath;
    }
  }

  if (frontendDist) {
    app.use(express.static(frontendDist));
  }

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      telegramMode,
      projectCount: projects.size,
    });
  });

  // SSE events
  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    eventBus.addClient(res);
    res.write("event: ping\ndata: {}\n\n");
  });

  // Register routes
  registerProjectRoutes(app, sessionService);
  registerTicketRoutes(app, sessionService, getProjects);
  registerSessionRoutes(app, sessionService);
  registerBrainstormRoutes(app, sessionService, getProjects);
  registerTelegramRoutes(
    app,
    () => globalConfig,
    async (config: GlobalConfig) => {
      globalConfig = config;
      await saveGlobalConfig(config);
    },
  );
  registerMcpRoutes(app);
  registerTemplateRoutes(app);
  registerTaskRoutes(app);
  registerRalphRoutes(app);
  registerArtifactChatRoutes(app, sessionService, getProjects);
  registerTicketChatRoutes(app, sessionService, getProjects);
  registerFolderRoutes(app);
  registerEpicRoutes(app, sessionService, () => projects);

  // SPA catch-all route - fallback to index.html for SPA routing
  if (frontendDist) {
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/events') || req.path.startsWith('/mcp')) {
        return next();
      }
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  // 404 handler for API routes
  app.use('/api', (req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Start server
  const portValue =
    process.env.POTATO_DAEMON_PORT || globalConfig?.daemon?.port || DEFAULT_PORT;
  const port = typeof portValue === 'string' ? parseInt(portValue, 10) : portValue;
  const host =
    process.env.POTATO_DAEMON_HOST || globalConfig?.daemon?.host || DEFAULT_HOST;
  server = app.listen(port, host, async () => {
    const urls = formatListenUrls(host, port);
    console.log(`Dashboard running at:\n${urls.map((u) => `  ${u}`).join('\n')}`);
    await writePid(process.pid);
    await writeDaemonInfo({
      url: `http://localhost:${port}/mcp`,
      port: typeof port === "string" ? parseInt(port, 10) : port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    // Start telegram provider if configured
    if (globalConfig?.telegram?.botToken && globalConfig?.telegram?.userId) {
      telegramProvider = new TelegramProvider();
      await telegramProvider.initialize(globalConfig.telegram);

      telegramProvider.setResponseCallback(
        async (providerId, context, answer) => {
          const handled = await chatService.handleResponse(
            providerId,
            context,
            answer,
          );

          // If response was written, check if we need to spawn a session
          if (handled && context.brainstormId) {
            try {
              const activeSession = getActiveSessionForBrainstorm(context.brainstormId);

              if (!activeSession || !sessionService?.isActive(activeSession.id)) {
                const projects = getProjects();
                const project = projects.get(context.projectId);

                if (project && sessionService) {
                  const newSessionId = await sessionService.spawnForBrainstorm(
                    context.projectId,
                    context.brainstormId,
                    project.path,
                  );
                  console.log(
                    `[Telegram] Spawned new session ${newSessionId} to continue brainstorm`,
                  );
                }
              }
            } catch (err) {
              console.error(
                "[Telegram] Error spawning brainstorm session:",
                (err as Error).message,
              );
            }
          } else if (handled && context.ticketId) {
            // Ticket session resumption
            try {
              // Check if there's an active session for this ticket
              const activeSession = getActiveSessionForTicket(context.ticketId);

              if (!activeSession || !sessionService?.isActive(activeSession.id)) {
                const projects = getProjects();
                const project = projects.get(context.projectId);

                if (project && sessionService) {
                  // Check if this is a suspended session (has pending question)
                  const pendingQuestion = readQuestion(context.projectId, context.ticketId);

                  if (pendingQuestion) {
                    // Suspended session — resume with --resume flag
                    const newSessionId = await sessionService.resumeSuspendedTicket(
                      context.projectId,
                      context.ticketId,
                      answer,
                    );
                    console.log(
                      `[Telegram] Resumed suspended session ${newSessionId} for ticket ${context.ticketId}`,
                    );
                  } else {
                    // Not suspended — spawn fresh session (legacy behavior)
                    const ticket = await getTicket(context.projectId, context.ticketId);
                    if (ticket) {
                      const newSessionId = await sessionService.spawnForTicket(
                        context.projectId,
                        context.ticketId,
                        ticket.phase,
                        project.path,
                      );
                      console.log(
                        `[Telegram] Spawned new session ${newSessionId} for ticket ${context.ticketId}`,
                      );
                    }
                  }
                }
              }
            } catch (err) {
              console.error(
                "[Telegram] Error spawning ticket session:",
                (err as Error).message,
              );
            }
          }

          return handled;
        },
      );

      chatService.registerProvider(telegramProvider);
      telegramProvider.startPolling();
      telegramMode = "polling";
      console.log("Telegram provider registered and polling");
    } else {
      console.log("Telegram not configured - provider disabled");
    }

    console.log(`Telegram mode: ${telegramMode}`);

    // Start Slack provider if configured
    const slackConfig = globalConfig?.slack;
    if (slackConfig?.appToken && slackConfig?.botToken) {
      slackProvider = new SlackProvider();
      await slackProvider.initialize(slackConfig);

      slackProvider.setResponseCallback(
        async (providerId, context, answer) => {
          const handled = await chatService.handleResponse(
            providerId,
            context,
            answer,
          );

          if (handled && context.brainstormId) {
            try {
              const activeSession = getActiveSessionForBrainstorm(context.brainstormId);

              if (!activeSession || !sessionService?.isActive(activeSession.id)) {
                const projects = getProjects();
                const project = projects.get(context.projectId);

                if (project && sessionService) {
                  const newSessionId = await sessionService.spawnForBrainstorm(
                    context.projectId,
                    context.brainstormId,
                    project.path,
                  );
                  console.log(
                    `[Slack] Spawned new session ${newSessionId} to continue brainstorm`,
                  );
                }
              }
            } catch (err) {
              console.error(
                "[Slack] Error spawning brainstorm session:",
                (err as Error).message,
              );
            }
          } else if (handled && context.ticketId) {
            try {
              const activeSession = getActiveSessionForTicket(context.ticketId);

              if (!activeSession || !sessionService?.isActive(activeSession.id)) {
                const projects = getProjects();
                const project = projects.get(context.projectId);

                if (project && sessionService) {
                  const pendingQuestion = readQuestion(context.projectId, context.ticketId);

                  if (pendingQuestion) {
                    const newSessionId = await sessionService.resumeSuspendedTicket(
                      context.projectId,
                      context.ticketId,
                      answer,
                    );
                    console.log(
                      `[Slack] Resumed suspended session ${newSessionId} for ticket ${context.ticketId}`,
                    );
                  } else {
                    const ticket = await getTicket(context.projectId, context.ticketId);
                    if (ticket) {
                      const newSessionId = await sessionService.spawnForTicket(
                        context.projectId,
                        context.ticketId,
                        ticket.phase,
                        project.path,
                      );
                      console.log(
                        `[Slack] Spawned new session ${newSessionId} for ticket ${context.ticketId}`,
                      );
                    }
                  }
                }
              }
            } catch (err) {
              console.error(
                "[Slack] Error spawning ticket session:",
                (err as Error).message,
              );
            }
          }

          return handled;
        },
      );

      chatService.registerProvider(slackProvider);
      await slackProvider.connect();
      console.log("Slack provider registered (Socket Mode)");
    } else {
      console.log("Slack not configured - provider disabled");
    }

    console.log("\nPotato Cannon Dashboard Ready!\n");

    // Recover interrupted sessions (mid-execution with worker-state.json)
    await recoverInterruptedSessions();

    // Recover any pending responses that need session resumption
    await recoverPendingResponses();
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");

  const timeoutId = setTimeout(() => {
    console.error("Shutdown timeout - forcing exit");
    process.exit(1);
  }, 10000);
  timeoutId.unref();

  artifactChatStore.stopCleanupTimer();

  if (telegramProvider) {
    await telegramProvider.shutdown();
  }

  if (slackProvider) {
    await slackProvider.shutdown();
  }

  if (sessionService) {
    await sessionService.stopAll(8000);
  }

  if (server) {
    server.close();
  }

  await removeDaemonInfo();
  await removePid();
  closeDatabase();
  process.exit(0);
}

// CLI exports
export async function startServer(
  options: { port?: number; host?: string; daemon?: boolean } = {},
): Promise<void> {
  const config = await loadGlobalConfig();
  const port = options.port || config?.daemon?.port || DEFAULT_PORT;
  const host = options.host || config?.daemon?.host || DEFAULT_HOST;

  if (options.daemon) {
    const { spawn } = await import("child_process");
    const { openSync, mkdirSync } = await import("fs");
    const { homedir } = await import("os");
    const logPath = path.join(homedir(), ".potato-cannon", "daemon.log");
    mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a");
    const child = spawn(process.argv[0], [fileURLToPath(import.meta.url)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        POTATO_DAEMON_PORT: port.toString(),
        POTATO_DAEMON_HOST: host,
      },
    });
    child.unref();
    console.log(`Daemon started with PID ${child.pid}`);
    return;
  }

  await main();
}

export async function stopServer(): Promise<void> {
  try {
    const response = await fetch(`http://localhost:${DEFAULT_PORT}/health`);
    if (response.ok) {
      const { readPid } = await import("../stores/config.store.js");
      const pid = await readPid();
      if (pid) {
        process.kill(pid, "SIGTERM");
        console.log(`Stopped daemon (PID ${pid})`);
      }
    }
  } catch {
    console.log("Daemon not running or PID file not found");
  }
}

export async function getStatus(): Promise<{
  running: boolean;
  [key: string]: unknown;
}> {
  try {
    const response = await fetch(`http://localhost:${DEFAULT_PORT}/health`);
    if (response.ok) {
      return { running: true, ...(await response.json()) };
    }
  } catch {
    // Not running
  }
  return { running: false };
}

/**
 * Auto-execute when this file is run directly.
 * This enables daemon mode: `startServer({ daemon: true })` spawns a detached
 * child process that runs this file (`node server.js`), which hits this guard
 * and calls `main()`.
 *
 * For debugging daemon crashes, run the compiled file directly to see output
 * in the terminal:
 *   node apps/daemon/dist/server/server.js
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[FATAL] Unhandled rejection:", err);
    process.exit(1);
  });
  main().catch((err) => {
    console.error("[FATAL] main() crashed:", err);
    process.exit(1);
  });
}
