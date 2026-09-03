import fs from "fs/promises";
import path from "path";
import { TASKS_DIR } from "../../config/paths.js";
import { eventBus } from "../../utils/event-bus.js";
import { getTicket as getTicketFromStore } from "../../stores/ticket.store.js";
import { addMessage } from "../../stores/conversation.store.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { ArtifactManifest, ArtifactEntry } from "../../types/index.js";

export const ticketTools: ToolDefinition[] = [
  {
    name: "get_ticket",
    description:
      "Get the current ticket details including phase, title, and description",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "attach_artifact",
    description:
      "Attach an artifact file to the ticket. The file path should be relative to the worktree.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Path to the artifact file (relative to worktree or absolute)",
        },
        artifact_type: {
          type: "string",
          description:
            'File extension of the artifact (e.g., ".md", ".txt", ".pdf")',
        },
        description: {
          type: "string",
          description: "Brief description of the artifact",
        },
      },
      required: ["file_path", "artifact_type"],
    },
  },
  {
    name: "add_ticket_comment",
    description:
      "Add a comment/note to the ticket for tracking progress or issues",
    inputSchema: {
      type: "object",
      properties: {
        comment: {
          type: "string",
          description: "The comment text",
        },
      },
      required: ["comment"],
    },
  },
  {
    name: "create_ticket",
    description:
      "Create a new ticket in the current project. Use this to convert a brainstorm into a formal ticket.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The ticket title",
        },
        description: {
          type: "string",
          description: "The ticket description (markdown)",
        },
        brainstormId: {
          type: "string",
          description: "Optional brainstorm ID this ticket originated from",
        },
        ticketNumber: {
          type: "string",
          description:
            "Optional custom ticket number (e.g. from JIRA). Replaces auto-generated ID. Only letters, numbers, hyphens, underscores allowed (max 20 chars).",
        },
        epicId: {
          type: "string",
          description:
            "Optional epic ID to assign this ticket to. Links the ticket to an existing epic.",
        },
      },
      required: ["title"],
    },
  },
];

interface CommentEntry {
  text: string;
  createdAt: string;
}

async function getTicket(ctx: McpContext): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to get ticket: ${response.statusText}`);
  }
  return await response.json();
}

async function attachArtifact(
  ctx: McpContext,
  filePath: string,
  artifactType: string,
  description?: string,
): Promise<{ filename: string; type: string; isNewVersion: boolean }> {
  const cwd = process.cwd();
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);

  const content = await fs.readFile(fullPath, "utf-8");
  const filename = path.basename(fullPath);

  const safeProject = ctx.projectId.replace(/\//g, "__");
  const artifactsDir = path.join(
    TASKS_DIR,
    safeProject,
    ctx.ticketId,
    "artifacts",
  );
  await fs.mkdir(artifactsDir, { recursive: true });

  // Fetch the current ticket phase
  let currentPhase: string | undefined;
  try {
    const ticket = await getTicketFromStore(ctx.projectId, ctx.ticketId);
    currentPhase = ticket.phase;
  } catch {
    // Ticket may not exist, phase will be undefined
  }

  const manifestPath = path.join(artifactsDir, "manifest.json");
  let manifest: ArtifactManifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  } catch {
    // File doesn't exist yet
  }

  const now = new Date().toISOString();
  const artifactPath = path.join(artifactsDir, filename);
  let isNewVersion = false;

  if (manifest[filename]) {
    // Existing artifact - create a version
    const existing = manifest[filename];
    const nextVersion = existing.versions.length + 1;

    // Copy current file to versioned filename
    const versionedFilename = `${filename}.v${nextVersion}`;
    const versionedPath = path.join(artifactsDir, versionedFilename);
    await fs.copyFile(artifactPath, versionedPath);

    // Push current metadata to versions array
    existing.versions.push({
      version: nextVersion,
      savedAt: existing.savedAt,
      description: existing.description,
      path: existing.path,
    });

    // Update current entry
    existing.savedAt = now;
    existing.description = description || existing.description;
    existing.path = filePath;
    existing.phase = currentPhase;
    existing.type = artifactType as ArtifactEntry["type"];

    isNewVersion = true;
  } else {
    // New artifact
    manifest[filename] = {
      type: artifactType as ArtifactEntry["type"],
      description: description || "",
      savedAt: now,
      path: filePath,
      phase: currentPhase,
      versions: [],
    };
  }

  // Write the new content
  await fs.writeFile(artifactPath, content);

  // Save manifest
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Add artifact message to conversation (if ticket has one)
  const ticket = await getTicketFromStore(ctx.projectId, ctx.ticketId);
  if (ticket.conversationId) {
    addMessage(ticket.conversationId, {
      type: "artifact",
      text: description || filename,
      metadata: {
        artifact: { filename, description: description || undefined },
      },
    });
  }

  // Emit event so frontend can refresh artifact list
  eventBus.emit("ticket:updated", {
    projectId: ctx.projectId,
    ticketId: ctx.ticketId,
  });

  return { filename, type: artifactType, isNewVersion };
}

async function addTicketComment(
  ctx: McpContext,
  comment: string,
): Promise<{ success: boolean }> {
  const safeProject = ctx.projectId.replace(/\//g, "__");
  const ticketDir = path.join(TASKS_DIR, safeProject, ctx.ticketId);
  await fs.mkdir(ticketDir, { recursive: true });

  const commentsFile = path.join(ticketDir, "comments.json");
  let comments: CommentEntry[] = [];
  try {
    comments = JSON.parse(await fs.readFile(commentsFile, "utf-8"));
  } catch {
    // File doesn't exist yet
  }

  comments.push({
    text: comment,
    createdAt: new Date().toISOString(),
  });

  await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2));

  // Also post to the ticket's conversation (POST /comments, added alongside
  // this tool) so agent comments show up in the dashboard's activity feed.
  // Previously this file write was the only record - nothing in the
  // frontend ever read comments.json, so every agent comment was invisible.
  // Kept as a separate call (not a refactor of the file write above) to
  // keep this patch minimal; comments.json stays as the on-disk record.
  try {
    await fetch(
      `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment, type: "notification" }),
      },
    );
  } catch {
    // Best-effort - the file write above is still the source of truth.
  }

  return { success: true };
}

async function createTicket(
  ctx: McpContext,
  title: string,
  description?: string,
  brainstormId?: string,
  ticketNumber?: string,
  epicId?: string,
): Promise<unknown> {
  const body: Record<string, string> = { title, description: description || "" };
  if (brainstormId) body.brainstormId = brainstormId;
  if (ticketNumber) body.ticketNumber = ticketNumber;
  if (epicId) body.epicId = epicId;

  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(errorBody.error || `Failed to create ticket: ${response.statusText}`);
  }
  return await response.json();
}

export const ticketHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  get_ticket: async (ctx) => {
    const ticket = await getTicket(ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(ticket, null, 2) }],
    };
  },

  attach_artifact: async (ctx, args) => {
    const result = await attachArtifact(
      ctx,
      args.file_path as string,
      args.artifact_type as string,
      args.description as string | undefined,
    );
    const versionMsg = result.isNewVersion ? " (new version)" : "";
    return {
      content: [
        {
          type: "text",
          text: `Artifact attached: ${result.filename} (${result.type})${versionMsg}`,
        },
      ],
    };
  },

  add_ticket_comment: async (ctx, args) => {
    await addTicketComment(ctx, args.comment as string);
    return {
      content: [{ type: "text", text: "Comment added" }],
    };
  },

  create_ticket: async (ctx, args) => {
    const ticket = (await createTicket(
      ctx,
      args.title as string,
      args.description as string | undefined,
      args.brainstormId as string | undefined,
      args.ticketNumber as string | undefined,
      args.epicId as string | undefined,
    )) as { id: string; title: string };
    return {
      content: [
        {
          type: "text",
          text: `Ticket created: ${ticket.id} - ${ticket.title}`,
        },
      ],
    };
  },
};
