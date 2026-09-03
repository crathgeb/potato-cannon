// Shared PTY-spawn-and-wire-handlers logic for ad-hoc, on-demand Q&A
// sessions - both artifact-chat (one artifact) and ticket-chat (a whole
// ticket). Extracted from artifact-chat.routes.ts so the fixes below live
// in one place instead of being copy-pasted per feature (which is how the
// PTY-chunking bug happened in the first place - the buggy pattern was
// copied from session.service.ts without anyone noticing it was broken).
import { execSync } from "child_process";
import { createWriteStream } from "fs";
import path from "path";
import pty from "node-pty";
import type { ArtifactChatSession } from "../../stores/artifact-chat.store.js";
import { artifactChatStore } from "../../stores/artifact-chat.store.js";
import { createStoredSession, endStoredSession, updateClaudeSessionId } from "../../stores/session.store.js";
import { SESSIONS_DIR } from "../../config/paths.js";

export function runAdhocChatProcess(
  session: ArtifactChatSession,
  args: string[],
  projectPath: string,
  projectId: string,
  ticketId: string,
  agentSource: string,
  meta: Record<string, unknown>
): void {
  const logPath = path.join(SESSIONS_DIR, `${session.sessionId}.jsonl`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  // Register in the shared `sessions` table, same as every other spawned
  // Claude process (see session.service.ts). Without this,
  // ChatService.askAsync's getActiveSessionForTicket(ticketId) lookup - how
  // it finds the claude_session_id to embed in a pending question for later
  // --resume - finds nothing for these ad-hoc processes, since they used to
  // exist only in the separate in-memory artifactChatStore. That silently
  // broke every follow-up: the question got asked and answered once, but
  // nothing was ever resumable after that.
  const storedSession = createStoredSession({
    projectId,
    ticketId,
    agentSource,
  });

  let claudeSessionIdCaptured = false;

  let claudePath: string;
  try {
    claudePath = execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    claudePath = path.join(process.env.HOME || "", ".local", "bin", "claude");
  }

  const proc = pty.spawn(claudePath, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: projectPath,
    env: {
      ...process.env,
      POTATO_PROJECT_ID: projectId,
      POTATO_TICKET_ID: ticketId,
      POTATO_BRAINSTORM_ID: session.contextId,
    },
  });

  // node-pty delivers data in ~1KB read chunks, not one chunk per logical
  // line - a single stream-json event (the system/init event especially,
  // with its full tool list, routinely exceeds that) can span several
  // onData calls. Splitting per-call with no carryover buffer means a split
  // event never reassembles and silently becomes unparseable - exactly how
  // claude_session_id capture below was failing 100% of the time despite
  // the data being genuinely present in the stream. Buffer across calls;
  // only process text up to the last newline in each call, carry the
  // remainder forward.
  let lineBuffer = "";

  proc.onData((data: string) => {
    lineBuffer += data;
    const lastNewline = lineBuffer.lastIndexOf("\n");
    if (lastNewline === -1) return;
    const complete = lineBuffer.slice(0, lastNewline);
    lineBuffer = lineBuffer.slice(lastNewline + 1);

    const lines = complete.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const logEntry = { ...event, timestamp: new Date().toISOString() };
        logStream.write(JSON.stringify(logEntry) + "\n");

        if (!claudeSessionIdCaptured && event.type === "system" && event.session_id) {
          claudeSessionIdCaptured = true;
          updateClaudeSessionId(storedSession.id, event.session_id);
        }
      } catch {
        logStream.write(
          JSON.stringify({
            type: "raw",
            content: line,
            timestamp: new Date().toISOString(),
          }) + "\n"
        );
      }
    }
  });

  proc.onExit(({ exitCode }) => {
    console.log(
      `[adhoc-chat:${agentSource}] Session ${session.contextId} exited with code: ${exitCode}`
    );

    const endReason =
      exitCode === 0 ? "completed" : exitCode === -1 ? "timeout" : "error";
    // Marks the panel's own session inactive again. This is correct even
    // after a resume: the agent answered (or didn't) and the process
    // exited the same way a fresh session does. A further follow-up goes
    // through the route's own resume path again, same as this one did.
    artifactChatStore.endSession(session.contextId, endReason);
    endStoredSession(storedSession.id, exitCode);

    logStream.write(
      JSON.stringify({
        type: "session_end",
        meta: {
          ...meta,
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
          endedAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      }) + "\n"
    );
    logStream.end();
  });
}

export function buildAdhocChatArgs(mcpConfig: unknown, promptOrMessage: string, resumeClaudeSessionId?: string): string[] {
  const args = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--disallowedTools",
    "Skill(superpowers:*),Edit,Write,NotebookEdit",
  ];
  if (resumeClaudeSessionId) {
    args.push("--resume", resumeClaudeSessionId);
  }
  args.push("--print", promptOrMessage);
  return args;
}
