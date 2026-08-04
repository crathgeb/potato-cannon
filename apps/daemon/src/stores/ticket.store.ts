import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { getDatabase } from "./db.js";
import { getProjectById } from "./project.store.js"; // Used by archiveTicket
import {
  createConversationStore,
  ConversationStore,
} from "./conversation.store.js";
import { TASKS_DIR } from "../config/paths.js";
import { ensureGlobalDir } from "./config.store.js";
import { removeWorktreeAndBranch } from "../services/session/worktree.js";
import { clearQuestion, clearResponse } from "./chat.store.js";
import type {
  Ticket,
  ArchiveResult,
  TicketPhase,
  CreateTicketInput,
  UpdateTicketInput,
  TicketHistoryEntry,
} from "../types/index.js";
import type { OrchestrationState } from "../types/orchestration.types.js";

import { TERMINAL_PHASES } from "../types/ticket.types.js";
import { getProjectPrefixFromDb } from "./utils.js";

// =============================================================================
// Types
// =============================================================================

export interface ListTicketsOptions {
  phase?: TicketPhase | null;
  archived?: boolean;
}

// Re-export ArchiveResult for consumers of this store
export type { ArchiveResult };

// =============================================================================
// Row Mappers
// =============================================================================

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  phase: string;
  created_at: string;
  updated_at: string;
  archived: number;
  archived_at: string | null;
  conversation_id: string | null;
  worker_state: string | null;
  pending_phase: string | null;
  epic_id: string | null;
  blocked: number;
  blocked_at: string | null;
}

interface HistoryRow {
  id: string;
  ticket_id: string;
  phase: string;
  entered_at: string;
  exited_at: string | null;
  reason: string | null;
}


// =============================================================================
// Helper Functions
// =============================================================================

function getProjectTicketsDir(projectId: string): string {
  const safeId = projectId.replace(/\//g, "__");
  return path.join(TASKS_DIR, safeId);
}

function getTicketDir(projectId: string, ticketId: string): string {
  return path.join(getProjectTicketsDir(projectId), ticketId);
}

// =============================================================================
// TicketStore Class
// =============================================================================

export class TicketStore {
  private conversationStore: ConversationStore;

  constructor(private db: Database.Database) {
    this.conversationStore = createConversationStore(db);
  }

  private static CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

  private validateCustomTicketNumber(ticketNumber: string): void {
    if (ticketNumber.length === 0 || ticketNumber.length > 20) {
      throw Object.assign(
        new Error("Invalid ticket number: must be 1-20 characters"),
        { code: "VALIDATION_ERROR" }
      );
    }
    if (!TicketStore.CUSTOM_ID_PATTERN.test(ticketNumber)) {
      throw Object.assign(
        new Error(
          "Invalid ticket number: only letters, numbers, hyphens, and underscores allowed"
        ),
        { code: "VALIDATION_ERROR" }
      );
    }
    const existing = this.db
      .prepare("SELECT id FROM tickets WHERE id = ?")
      .get(ticketNumber);
    if (existing) {
      throw Object.assign(
        new Error(`Ticket number '${ticketNumber}' already exists`),
        { code: "CONFLICT_ERROR" }
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Counter Management
  // ---------------------------------------------------------------------------

  private getNextTicketNumber(projectId: string): number {
    const row = this.db
      .prepare("SELECT next_number FROM ticket_counters WHERE project_id = ?")
      .get(projectId) as { next_number: number } | undefined;

    const nextNumber = row?.next_number ?? 1;

    // Upsert counter
    this.db
      .prepare(
        `INSERT INTO ticket_counters (project_id, next_number)
         VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET next_number = ?`
      )
      .run(projectId, nextNumber + 1, nextNumber + 1);

    return nextNumber;
  }

  private generateTicketId(projectId: string): string {
    const prefix = getProjectPrefixFromDb(this.db, projectId);
    const number = this.getNextTicketNumber(projectId);
    return `${prefix}-${number}`;
  }

  private generateTicketIdWithRetry(projectId: string): string {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const id = this.generateTicketId(projectId);
      const exists = this.db
        .prepare("SELECT 1 FROM tickets WHERE id = ?")
        .get(id);
      if (!exists) return id;
    }
    throw new Error("Failed to generate unique ticket ID after 5 attempts");
  }

  // ---------------------------------------------------------------------------
  // Ticket CRUD
  // ---------------------------------------------------------------------------

  listTickets(projectId: string, options: ListTicketsOptions = {}): Ticket[] {
    const { phase = null, archived = false } = options;

    let sql = "SELECT * FROM tickets WHERE project_id = ?";
    const params: unknown[] = [projectId];

    if (archived === true) {
      sql += " AND archived = 1";
    } else if (archived === false) {
      sql += " AND archived = 0";
    }

    if (phase) {
      sql += " AND phase = ?";
      params.push(phase);
    }

    sql += " ORDER BY updated_at DESC";

    const rows = this.db.prepare(sql).all(...params) as TicketRow[];
    return rows.map((row) => this.rowToTicket(row));
  }

  getTicket(projectId: string, ticketId: string): Ticket | null {
    const row = this.db
      .prepare("SELECT * FROM tickets WHERE id = ? AND project_id = ?")
      .get(ticketId, projectId) as TicketRow | undefined;

    if (!row) return null;
    return this.rowToTicket(row);
  }

  countTicketsInPhase(projectId: string, phase: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM tickets WHERE project_id = ? AND phase = ? AND archived = 0"
      )
      .get(projectId, phase) as { count: number };
    return row.count;
  }

  getTicketById(ticketId: string): Ticket | null {
    const row = this.db
      .prepare("SELECT * FROM tickets WHERE id = ?")
      .get(ticketId) as TicketRow | undefined;

    if (!row) return null;
    return this.rowToTicket(row);
  }

  createTicket(projectId: string, input: CreateTicketInput): Ticket {
    let id: string;
    if (input.ticketNumber !== undefined) {
      this.validateCustomTicketNumber(input.ticketNumber);
      id = input.ticketNumber;
    } else {
      id = this.generateTicketIdWithRetry(projectId);
    }
    const now = new Date().toISOString();
    const initialPhase = "Ideas";
    const description = input.description || "";

    // Create associated conversation
    const conversation = this.conversationStore.createConversation(projectId);

    // Insert ticket with conversation_id and description
    this.db
      .prepare(
        `INSERT INTO tickets (id, project_id, title, description, phase, created_at, updated_at, archived, conversation_id, epic_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, projectId, input.title, description, initialPhase, now, now, conversation.id, input.epicId || null);

    // Insert initial history entry
    const historyId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ticket_history (id, ticket_id, phase, entered_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(historyId, id, initialPhase, now);

    return this.getTicket(projectId, id)!;
  }

  updateTicket(
    projectId: string,
    ticketId: string,
    updates: UpdateTicketInput
  ): Ticket | null {
    const existing = this.getTicket(projectId, ticketId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const fields: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }

    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description);
    }

    if (updates.pendingPhase !== undefined) {
      fields.push("pending_phase = ?");
      values.push(updates.pendingPhase || null);
    }

    if (updates.blocked !== undefined && updates.blocked !== (existing.blocked ?? false)) {
      fields.push("blocked = ?");
      values.push(updates.blocked ? 1 : 0);
      fields.push("blocked_at = ?");
      values.push(updates.blocked ? now : null);
    }

    if (updates.phase !== undefined && updates.phase !== existing.phase) {
      fields.push("phase = ?");
      values.push(updates.phase);

      // Close out the current history entry
      this.db
        .prepare(
          `UPDATE ticket_history SET exited_at = ?
           WHERE ticket_id = ? AND exited_at IS NULL`
        )
        .run(now, ticketId);

      // Create new history entry for the new phase
      const historyId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ticket_history (id, ticket_id, phase, entered_at, reason)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(historyId, ticketId, updates.phase, now, updates.reason ?? null);

      // Clear pending_phase when ticket actually moves to a new phase
      fields.push("pending_phase = ?");
      values.push(null);
    }

    values.push(ticketId);
    this.db
      .prepare(`UPDATE tickets SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getTicket(projectId, ticketId);
  }

  deleteTicket(projectId: string, ticketId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM tickets WHERE id = ? AND project_id = ?")
      .run(ticketId, projectId);
    return result.changes > 0;
  }

  archiveTicket(projectId: string, ticketId: string): Ticket | null {
    const existing = this.getTicket(projectId, ticketId);
    if (!existing) return null;

    if (existing.phase !== "Done") {
      throw new Error("Only tickets in Done phase can be archived");
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tickets SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(now, now, ticketId);

    return this.getTicket(projectId, ticketId);
  }

  restoreTicket(projectId: string, ticketId: string): Ticket | null {
    const existing = this.getTicket(projectId, ticketId);
    if (!existing) return null;

    const now = new Date().toISOString();

    // Remove archived status
    this.db
      .prepare(
        `UPDATE tickets SET archived = 0, archived_at = NULL, phase = 'Done', updated_at = ? WHERE id = ?`
      )
      .run(now, ticketId);

    // Add history entry for restore
    const historyId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ticket_history (id, ticket_id, phase, entered_at)
         VALUES (?, ?, 'Done', ?)`
      )
      .run(historyId, ticketId, now);

    return this.getTicket(projectId, ticketId);
  }

  // ---------------------------------------------------------------------------
  // History Management
  // ---------------------------------------------------------------------------

  getTicketHistory(ticketId: string): TicketHistoryEntry[] {
    const historyRows = this.db
      .prepare(
        `SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY entered_at`
      )
      .all(ticketId) as HistoryRow[];

    return historyRows.map((row) => this.rowToHistoryEntry(row));
  }

  getCurrentHistoryEntry(ticketId: string): { id: string; entry: TicketHistoryEntry } | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ticket_history WHERE ticket_id = ? AND exited_at IS NULL ORDER BY entered_at DESC LIMIT 1`
      )
      .get(ticketId) as HistoryRow | undefined;

    if (!row) return null;
    return { id: row.id, entry: this.rowToHistoryEntry(row) };
  }

  // ---------------------------------------------------------------------------
  // Worker State Management
  // ---------------------------------------------------------------------------

  getWorkerState(ticketId: string): OrchestrationState | null {
    const row = this.db
      .prepare("SELECT worker_state FROM tickets WHERE id = ?")
      .get(ticketId) as { worker_state: string | null } | undefined;
    if (!row?.worker_state) return null;
    return JSON.parse(row.worker_state);
  }

  setWorkerState(ticketId: string, state: OrchestrationState): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tickets SET worker_state = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(state), now, ticketId);
  }

  clearWorkerState(ticketId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tickets SET worker_state = NULL, updated_at = ? WHERE id = ?")
      .run(now, ticketId);
  }

  /**
   * Get all history entries for a ticket, ordered by entered_at.
   */
  getPhaseHistoryEntries(ticketId: string): Array<{ id: string; phase: string; enteredAt: string; exitedAt: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT id, phase, entered_at, exited_at FROM ticket_history WHERE ticket_id = ? ORDER BY entered_at`
      )
      .all(ticketId) as Array<{ id: string; phase: string; entered_at: string; exited_at: string | null }>;

    return rows.map(row => ({
      id: row.id,
      phase: row.phase,
      enteredAt: row.entered_at,
      exitedAt: row.exited_at
    }));
  }

  /**
   * Delete history entries by their IDs.
   */
  deleteHistoryEntries(historyIds: string[]): number {
    if (historyIds.length === 0) return 0;

    const placeholders = historyIds.map(() => '?').join(',');
    const result = this.db
      .prepare(`DELETE FROM ticket_history WHERE id IN (${placeholders})`)
      .run(...historyIds);
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Row Mappers
  // ---------------------------------------------------------------------------

  private rowToTicket(row: TicketRow): Ticket {
    const history = this.getTicketHistory(row.id);

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      phase: row.phase as TicketPhase,
      project: row.project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      history,
      archived: row.archived === 1,
      archivedAt: row.archived_at || undefined,
      conversationId: row.conversation_id || undefined,
      pendingPhase: row.pending_phase || undefined,
      epicId: row.epic_id || undefined,
      blocked: row.blocked === 1,
      blockedAt: row.blocked_at || undefined,
    };
  }

  private rowToHistoryEntry(row: HistoryRow): TicketHistoryEntry {
    return {
      phase: row.phase as TicketPhase,
      at: row.entered_at,
      endedAt: row.exited_at || undefined,
      reason: row.reason || undefined,
    };
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createTicketStore(db: Database.Database): TicketStore {
  return new TicketStore(db);
}

// =============================================================================
// Directory Helpers
// =============================================================================

async function ensureTicketDir(projectId: string, ticketId: string): Promise<string> {
  await ensureGlobalDir();
  const ticketDir = getTicketDir(projectId, ticketId);
  await fs.mkdir(ticketDir, { recursive: true });
  await fs.mkdir(path.join(ticketDir, "images"), { recursive: true });
  await fs.mkdir(path.join(ticketDir, "artifacts"), { recursive: true });
  return ticketDir;
}

// =============================================================================
// Convenience Functions (Singleton + Async for file operations)
// =============================================================================

export function listTickets(
  projectId: string,
  options: ListTicketsOptions = {}
): Ticket[] {
  const store = new TicketStore(getDatabase());
  return store.listTickets(projectId, options);
}

export function getTicket(
  projectId: string,
  ticketId: string
): Ticket {
  const store = new TicketStore(getDatabase());
  const ticket = store.getTicket(projectId, ticketId);
  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found`);
  }
  return ticket;
}

export async function createTicket(
  projectId: string,
  input: CreateTicketInput
): Promise<Ticket> {
  const store = new TicketStore(getDatabase());
  const ticket = store.createTicket(projectId, input);

  // Create directory for images and artifacts
  await ensureTicketDir(projectId, ticket.id);

  return ticket;
}

export async function updateTicket(
  projectId: string,
  ticketId: string,
  updates: UpdateTicketInput
): Promise<Ticket> {
  const store = new TicketStore(getDatabase());
  const ticket = store.updateTicket(projectId, ticketId, updates);

  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found`);
  }

  // Handle terminal phase cleanup
  if (updates.phase && isTerminalPhase(updates.phase)) {
    await clearQuestion(projectId, ticketId);
    await clearResponse(projectId, ticketId);
  }

  return ticket;
}

export async function deleteTicket(
  projectId: string,
  ticketId: string
): Promise<void> {
  const store = new TicketStore(getDatabase());
  store.deleteTicket(projectId, ticketId);

  // Delete ticket directory
  const ticketDir = getTicketDir(projectId, ticketId);
  await fs.rm(ticketDir, { recursive: true, force: true });
}

export async function archiveTicket(
  projectId: string,
  ticketId: string
): Promise<ArchiveResult> {
  const store = new TicketStore(getDatabase());
  const ticket = store.archiveTicket(projectId, ticketId);

  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found`);
  }

  // Get project path for git cleanup
  const project = getProjectById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const cleanup = await removeWorktreeAndBranch(project.path, ticketId);

  return { ticket, cleanup };
}

export function restoreTicket(
  projectId: string,
  ticketId: string
): Ticket {
  const store = new TicketStore(getDatabase());
  const ticket = store.restoreTicket(projectId, ticketId);

  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found`);
  }

  return ticket;
}

export function isTerminalPhase(phase: TicketPhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}

// =============================================================================
// Worker State Functions
// =============================================================================

export function getWorkerState(ticketId: string): OrchestrationState | null {
  return new TicketStore(getDatabase()).getWorkerState(ticketId);
}

export function setWorkerState(ticketId: string, state: OrchestrationState): void {
  new TicketStore(getDatabase()).setWorkerState(ticketId, state);
}

export function clearWorkerState(ticketId: string): void {
  new TicketStore(getDatabase()).clearWorkerState(ticketId);
}

export function getPhaseHistoryEntries(ticketId: string): Array<{ id: string; phase: string; enteredAt: string; exitedAt: string | null }> {
  return new TicketStore(getDatabase()).getPhaseHistoryEntries(ticketId);
}

export function deleteHistoryEntries(historyIds: string[]): number {
  return new TicketStore(getDatabase()).deleteHistoryEntries(historyIds);
}

export function countTicketsInPhase(projectId: string, phase: string): number {
  return new TicketStore(getDatabase()).countTicketsInPhase(projectId, phase);
}

// =============================================================================
// Image Functions (File-based)
// =============================================================================

import type { TicketImage } from "../types/index.js";

export async function listTicketImages(
  projectId: string,
  ticketId: string
): Promise<TicketImage[]> {
  const imagesDir = path.join(getTicketDir(projectId, ticketId), "images");
  const images: TicketImage[] = [];

  try {
    const entries = await fs.readdir(imagesDir);
    for (const entry of entries) {
      const filePath = path.join(imagesDir, entry);
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        images.push({
          name: entry,
          path: filePath,
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
        });
      }
    }
  } catch {
    // No images directory
  }

  return images;
}

export async function saveTicketImage(
  projectId: string,
  ticketId: string,
  filename: string,
  buffer: Buffer
): Promise<TicketImage> {
  const imagesDir = path.join(getTicketDir(projectId, ticketId), "images");
  await fs.mkdir(imagesDir, { recursive: true });

  const filePath = path.join(imagesDir, filename);
  await fs.writeFile(filePath, buffer);

  const stat = await fs.stat(filePath);
  return {
    name: filename,
    path: filePath,
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
  };
}

export async function deleteTicketImage(
  projectId: string,
  ticketId: string,
  filename: string
): Promise<void> {
  const filePath = path.join(
    getTicketDir(projectId, ticketId),
    "images",
    filename
  );
  await fs.unlink(filePath);
}

// =============================================================================
// Artifact Functions (File-based)
// =============================================================================

import type {
  ArtifactManifest,
  ArtifactEntry,
  ArtifactListItem,
} from "../types/index.js";

function getTicketArtifactsDir(projectId: string, ticketId: string): string {
  return path.join(getTicketDir(projectId, ticketId), "artifacts");
}

export async function listArtifacts(
  projectId: string,
  ticketId: string
): Promise<ArtifactListItem[]> {
  const artifactsDir = getTicketArtifactsDir(projectId, ticketId);
  const manifestPath = path.join(artifactsDir, "manifest.json");

  try {
    const manifest: ArtifactManifest = JSON.parse(
      await fs.readFile(manifestPath, "utf-8")
    );

    return Object.entries(manifest).map(([filename, entry]) => ({
      filename,
      type: entry.type,
      description: entry.description,
      savedAt: entry.savedAt,
      phase: entry.phase,
      versionCount: entry.versions.length + 1,
    }));
  } catch {
    return [];
  }
}

export async function saveArtifact(
  projectId: string,
  ticketId: string,
  filename: string,
  content: string,
  metadata: {
    type?: ArtifactEntry["type"];
    description?: string;
    path?: string;
  } = {}
): Promise<{ filename: string; path: string; isNewVersion: boolean; wroteThrough: boolean | null }> {
  const artifactsDir = getTicketArtifactsDir(projectId, ticketId);
  await fs.mkdir(artifactsDir, { recursive: true });

  const filePath = path.join(artifactsDir, filename);
  const manifestPath = path.join(artifactsDir, "manifest.json");

  let manifest: ArtifactManifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  } catch {
    // No manifest yet
  }

  const now = new Date().toISOString();
  let isNewVersion = false;

  if (manifest[filename]) {
    // Existing artifact - create a version
    const existing = manifest[filename];
    const nextVersion = existing.versions.length + 1;

    // Copy current file to versioned filename
    const versionedFilename = `${filename}.v${nextVersion}`;
    const versionedPath = path.join(artifactsDir, versionedFilename);
    await fs.copyFile(filePath, versionedPath);

    // Push current metadata to versions array
    existing.versions.push({
      version: nextVersion,
      savedAt: existing.savedAt,
      description: existing.description,
      path: existing.path,
    });

    // Update current entry with new metadata. Only overwrite `path` when a
    // new one is explicitly given - previously this unconditionally set it
    // to `metadata.path`, which is undefined on a plain manual edit (the
    // route doesn't pass metadata), silently erasing the link to the real
    // worktree file on the very first edit.
    existing.savedAt = now;
    existing.description = metadata.description || existing.description;
    if (metadata.path !== undefined) {
      existing.path = metadata.path;
    }
    if (metadata.type) {
      existing.type = metadata.type;
    }

    isNewVersion = true;
  } else {
    // New artifact
    manifest[filename] = {
      type: metadata.type || "other",
      description: metadata.description || "",
      savedAt: now,
      path: metadata.path,
      versions: [],
    };
  }

  // Write the new content to Cannon's own copy (what the viewer/editor reads)
  await fs.writeFile(filePath, content);

  // Save manifest
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Write through to the real source file too, if this artifact is backed
  // by one - otherwise a manual edit here only ever updates Cannon's own
  // display copy, and any agent that later reads the real file (which is
  // all of them - they operate on the actual worktree, not this cache)
  // never sees the edit at all.
  const realPath = manifest[filename].path;
  let wroteThrough: boolean | null = null;
  if (realPath && realPath !== filePath) {
    try {
      await fs.writeFile(realPath, content);
      wroteThrough = true;
    } catch (err) {
      wroteThrough = false;
      console.error(
        `[saveArtifact] Failed to write through to real path ${realPath}: ${(err as Error).message}`
      );
    }
  }

  return { filename, path: filePath, isNewVersion, wroteThrough };
}

export async function getArtifactContent(
  projectId: string,
  ticketId: string,
  filename: string
): Promise<string> {
  const artifactsDir = getTicketArtifactsDir(projectId, ticketId);
  const filePath = path.join(artifactsDir, filename);
  return fs.readFile(filePath, "utf-8");
}

/**
 * Delete all artifacts belonging to any of the specified phases.
 * Removes files from disk and updates the manifest.
 * Returns the number of artifacts deleted.
 */
export async function deleteArtifactsForPhases(
  projectId: string,
  ticketId: string,
  phases: string[]
): Promise<number> {
  if (phases.length === 0) return 0;

  const artifactsDir = getTicketArtifactsDir(projectId, ticketId);
  const manifestPath = path.join(artifactsDir, "manifest.json");

  let manifest: ArtifactManifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  } catch {
    // No manifest - nothing to delete
    return 0;
  }

  const phasesSet = new Set(phases);
  const toDelete: string[] = [];
  const updatedManifest: ArtifactManifest = {};

  // Separate artifacts to keep vs delete
  for (const [filename, entry] of Object.entries(manifest)) {
    if (entry.phase && phasesSet.has(entry.phase)) {
      toDelete.push(filename);
      // Also collect versioned files
      for (const version of entry.versions) {
        const versionedFilename = `${filename}.v${version.version}`;
        toDelete.push(versionedFilename);
      }
    } else {
      updatedManifest[filename] = entry;
    }
  }

  if (toDelete.length === 0) return 0;

  // Delete files from disk
  for (const filename of toDelete) {
    const filePath = path.join(artifactsDir, filename);
    try {
      await fs.unlink(filePath);
    } catch {
      // File may not exist, ignore
    }
  }

  // Write updated manifest (or delete if empty)
  if (Object.keys(updatedManifest).length === 0) {
    try {
      await fs.unlink(manifestPath);
    } catch {
      // Ignore
    }
  } else {
    await fs.writeFile(manifestPath, JSON.stringify(updatedManifest, null, 2));
  }

  // Return count of main artifacts deleted (not versions)
  return Object.keys(manifest).length - Object.keys(updatedManifest).length;
}

// =============================================================================
// Conversation Functions (File-based)
// =============================================================================

import type { ConversationEntry } from "../types/index.js";

export async function loadConversations(
  projectId: string,
  ticketId: string
): Promise<ConversationEntry[]> {
  const conversationsPath = path.join(
    getTicketDir(projectId, ticketId),
    "conversations.json"
  );
  try {
    return JSON.parse(await fs.readFile(conversationsPath, "utf-8"));
  } catch {
    return [];
  }
}

export async function appendConversation(
  projectId: string,
  ticketId: string,
  entry: ConversationEntry
): Promise<ConversationEntry[]> {
  const ticketDir = getTicketDir(projectId, ticketId);
  const conversationsPath = path.join(ticketDir, "conversations.json");

  let conversations: ConversationEntry[] = [];
  try {
    conversations = JSON.parse(await fs.readFile(conversationsPath, "utf-8"));
  } catch {
    // File doesn't exist yet
  }

  const existingIndex = conversations.findIndex((c) => c.id === entry.id);
  if (existingIndex >= 0) {
    conversations[existingIndex] = {
      ...conversations[existingIndex],
      ...entry,
    };
  } else {
    conversations.push(entry);
  }

  await fs.writeFile(conversationsPath, JSON.stringify(conversations, null, 2));
  return conversations;
}

