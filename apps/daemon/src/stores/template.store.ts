// src/stores/template.store.ts
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { TEMPLATES_DIR } from "../config/paths.js";
import { getDatabase } from "./db.js";
import { getProjectById } from "./project.store.js";
import {
  hasProjectTemplate,
  getProjectTemplate,
  getProjectAgentPrompt,
  hasProjectAgentOverride,
  getProjectAgentOverride,
} from "./project-template.store.js";
import { incrementVersion, getUpgradeType, legacyVersionToSemver } from "../utils/semver.js";
import type {
  WorkflowTemplate,
  Phase,
} from "../types/template.types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

export interface RegisteredTemplate {
  id: string;
  name: string;
  version: string;
  description?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterTemplateInput {
  name: string;
  version: string;
  description?: string;
  isDefault?: boolean;
}

export interface UpdateTemplateInput {
  version?: string;
  description?: string;
}

interface TemplateRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Row Mapper
// ============================================================================

function rowToTemplate(row: TemplateRow): RegisteredTemplate {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description ?? undefined,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// Store Interface
// ============================================================================

export interface TemplateStore {
  // Registry (SQLite)
  registerTemplate(input: RegisterTemplateInput): RegisteredTemplate;
  getTemplate(id: string): RegisteredTemplate | null;
  getTemplateByName(name: string): RegisteredTemplate | null;
  listTemplates(): RegisteredTemplate[];
  updateTemplate(id: string, updates: UpdateTemplateInput): RegisteredTemplate | null;
  setDefaultTemplate(id: string): boolean;
  getDefaultTemplate(): RegisteredTemplate | null;
  deleteTemplate(id: string): boolean;
  upsertTemplate(input: RegisterTemplateInput): RegisteredTemplate;
}

// ============================================================================
// Store Factory (for DI/testing)
// ============================================================================

export function createTemplateStore(db: Database.Database): TemplateStore {
  // Prepared statements
  const insertStmt = db.prepare(`
    INSERT INTO templates (id, name, version, description, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const getByIdStmt = db.prepare(`SELECT * FROM templates WHERE id = ?`);
  const getByNameStmt = db.prepare(`SELECT * FROM templates WHERE name = ?`);
  const listStmt = db.prepare(`SELECT * FROM templates ORDER BY created_at ASC`);

  const updateStmt = db.prepare(`
    UPDATE templates
    SET version = COALESCE(?, version),
        description = COALESCE(?, description),
        updated_at = ?
    WHERE id = ?
  `);

  const clearDefaultStmt = db.prepare(`UPDATE templates SET is_default = 0`);
  const setDefaultStmt = db.prepare(`UPDATE templates SET is_default = 1, updated_at = ? WHERE id = ?`);

  const getDefaultStmt = db.prepare(`
    SELECT * FROM templates WHERE is_default = 1 LIMIT 1
  `);
  const getFirstStmt = db.prepare(`
    SELECT * FROM templates ORDER BY created_at ASC LIMIT 1
  `);

  const deleteStmt = db.prepare(`DELETE FROM templates WHERE id = ?`);

  return {
    registerTemplate(input: RegisterTemplateInput): RegisteredTemplate {
      const id = `tmpl_${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const isDefault = input.isDefault ? 1 : 0;

      // If this is marked as default, clear others first
      if (input.isDefault) {
        clearDefaultStmt.run();
      }

      insertStmt.run(
        id,
        input.name,
        input.version,
        input.description ?? null,
        isDefault,
        now,
        now
      );

      return {
        id,
        name: input.name,
        version: input.version,
        description: input.description,
        isDefault: !!input.isDefault,
        createdAt: now,
        updatedAt: now,
      };
    },

    getTemplate(id: string): RegisteredTemplate | null {
      const row = getByIdStmt.get(id) as TemplateRow | undefined;
      return row ? rowToTemplate(row) : null;
    },

    getTemplateByName(name: string): RegisteredTemplate | null {
      const row = getByNameStmt.get(name) as TemplateRow | undefined;
      return row ? rowToTemplate(row) : null;
    },

    listTemplates(): RegisteredTemplate[] {
      const rows = listStmt.all() as TemplateRow[];
      return rows.map(rowToTemplate);
    },

    updateTemplate(id: string, updates: UpdateTemplateInput): RegisteredTemplate | null {
      const existing = getByIdStmt.get(id) as TemplateRow | undefined;
      if (!existing) {
        return null;
      }

      const now = new Date().toISOString();
      updateStmt.run(
        updates.version ?? null,
        updates.description ?? null,
        now,
        id
      );

      const updated = getByIdStmt.get(id) as TemplateRow;
      return rowToTemplate(updated);
    },

    setDefaultTemplate(id: string): boolean {
      const existing = getByIdStmt.get(id) as TemplateRow | undefined;
      if (!existing) {
        return false;
      }

      const now = new Date().toISOString();
      clearDefaultStmt.run();
      setDefaultStmt.run(now, id);
      return true;
    },

    getDefaultTemplate(): RegisteredTemplate | null {
      // First try explicit default
      let row = getDefaultStmt.get() as TemplateRow | undefined;
      if (row) {
        return rowToTemplate(row);
      }

      // Fall back to first template
      row = getFirstStmt.get() as TemplateRow | undefined;
      return row ? rowToTemplate(row) : null;
    },

    deleteTemplate(id: string): boolean {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },

    upsertTemplate(input: RegisterTemplateInput): RegisteredTemplate {
      const existing = getByNameStmt.get(input.name) as TemplateRow | undefined;

      if (existing) {
        const now = new Date().toISOString();

        // If setting as default, clear others first
        if (input.isDefault) {
          clearDefaultStmt.run();
          db.prepare(`UPDATE templates SET is_default = 1 WHERE id = ?`).run(existing.id);
        }

        updateStmt.run(
          input.version,
          input.description ?? null,
          now,
          existing.id
        );

        const updated = getByIdStmt.get(existing.id) as TemplateRow;
        return rowToTemplate(updated);
      }

      return this.registerTemplate(input);
    },
  };
}

// ============================================================================
// Singleton accessor (uses global DB)
// ============================================================================

let _store: TemplateStore | null = null;

function getStore(): TemplateStore {
  if (!_store) {
    _store = createTemplateStore(getDatabase());
  }
  return _store;
}

// ============================================================================
// Exported Registry Functions (delegate to store)
// ============================================================================

export function registerTemplate(input: RegisterTemplateInput): RegisteredTemplate {
  return getStore().registerTemplate(input);
}

export function getTemplateById(id: string): RegisteredTemplate | null {
  return getStore().getTemplate(id);
}

export function getTemplateByName(name: string): RegisteredTemplate | null {
  return getStore().getTemplateByName(name);
}

export function listRegisteredTemplates(): RegisteredTemplate[] {
  return getStore().listTemplates();
}

export function updateRegisteredTemplate(
  id: string,
  updates: UpdateTemplateInput
): RegisteredTemplate | null {
  return getStore().updateTemplate(id, updates);
}

export function setDefaultTemplate(id: string): boolean {
  return getStore().setDefaultTemplate(id);
}

export function getDefaultTemplate(): RegisteredTemplate | null {
  return getStore().getDefaultTemplate();
}

export function deleteRegisteredTemplate(id: string): boolean {
  return getStore().deleteTemplate(id);
}

export function upsertTemplate(input: RegisterTemplateInput): RegisteredTemplate {
  return getStore().upsertTemplate(input);
}

// ============================================================================
// File Path Helpers
// ============================================================================

function getTemplateDir(name: string): string {
  return path.join(TEMPLATES_DIR, name);
}

function getWorkflowPath(name: string): string {
  return path.join(getTemplateDir(name), "workflow.json");
}

function getAgentPath(name: string, agentFile: string): string {
  return path.join(getTemplateDir(name), agentFile);
}

export async function ensureTemplatesDir(): Promise<void> {
  await fs.mkdir(TEMPLATES_DIR, { recursive: true });
}

// ============================================================================
// File-based Workflow/Agent Access (preserved from original)
// ============================================================================

/**
 * Get the workflow definition for a template from disk.
 */
export async function getWorkflow(name: string): Promise<WorkflowTemplate | null> {
  try {
    const content = await fs.readFile(getWorkflowPath(name), "utf-8");
    const template = JSON.parse(content) as WorkflowTemplate;
    return template;
  } catch {
    return null;
  }
}

/**
 * Get changelog for a template from the global catalog.
 */
export async function getTemplateChangelog(name: string): Promise<string | null> {
  try {
    const changelogPath = path.join(getTemplateDir(name), "changelog.md");
    return await fs.readFile(changelogPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get workflow template with full phases (Ideas, Blocked, Done injected).
 */
export async function getWorkflowWithFullPhases(
  name: string,
): Promise<WorkflowTemplate | null> {
  const template = await getWorkflow(name);
  if (!template) return null;

  // Inject Ideas at start, Done at end. "Blocked" is no longer a phase -
  // superseded by the per-ticket `blocked` flag (bright red outline,
  // toggled in place), which doesn't strand a ticket out of its real
  // position in the pipeline the way moving it to a separate column did.
  const ideasPhase: Phase = {
    id: "Ideas",
    name: "Ideas",
    description: "Tickets start here",
    workers: [],
    transitions: { next: template.phases[0]?.id || "Done", manual: true },
  };

  const donePhase: Phase = {
    id: "Done",
    name: "Done",
    description: "Ticket completed",
    workers: [],
    transitions: { next: null },
  };

  return {
    ...template,
    phases: [ideasPhase, ...template.phases, donePhase],
  };
}

/**
 * Create a new template with workflow file and registry entry.
 */
export async function createTemplate(
  name: string,
  description: string,
  phases: Phase[],
): Promise<WorkflowTemplate> {
  await ensureTemplatesDir();

  const templateDir = getTemplateDir(name);
  await fs.mkdir(templateDir, { recursive: true });
  await fs.mkdir(path.join(templateDir, "agents"), { recursive: true });

  const template: WorkflowTemplate = {
    name,
    description,
    version: "1.0.0",
    phases,
  };

  await fs.writeFile(getWorkflowPath(name), JSON.stringify(template, null, 2));

  // Register in SQLite
  const isFirstTemplate = getStore().listTemplates().length === 0;
  getStore().registerTemplate({
    name,
    version: "1.0.0",
    description,
    isDefault: isFirstTemplate,
  });

  return template;
}

/**
 * Update an existing template's workflow file and registry entry.
 */
export async function updateTemplate(
  name: string,
  updates: { description?: string; phases?: Phase[] },
): Promise<WorkflowTemplate> {
  const template = await getWorkflow(name);
  if (!template) {
    throw new Error(`Template "${name}" not found`);
  }

  const updated: WorkflowTemplate = {
    ...template,
    description: updates.description ?? template.description,
    phases: updates.phases ?? template.phases,
    version: incrementVersion(
      typeof template.version === "number" ? `${template.version}.0.0` : template.version,
      "patch"
    ),
  };

  await fs.writeFile(getWorkflowPath(name), JSON.stringify(updated, null, 2));

  // Update registry
  const registered = getStore().getTemplateByName(name);
  if (registered) {
    getStore().updateTemplate(registered.id, {
      version: updated.version,
      description: updated.description,
    });
  }

  return updated;
}

/**
 * Delete a template (both files and registry entry).
 */
export async function deleteTemplate(name: string): Promise<void> {
  const templateDir = getTemplateDir(name);
  await fs.rm(templateDir, { recursive: true, force: true });

  // Remove from registry
  const registered = getStore().getTemplateByName(name);
  if (registered) {
    getStore().deleteTemplate(registered.id);
  }
}

/**
 * Set template as default by name.
 */
export async function setDefaultTemplateByName(name: string): Promise<void> {
  const registered = getStore().getTemplateByName(name);
  if (registered) {
    getStore().setDefaultTemplate(registered.id);
  }
}

/**
 * Get agent prompt content from a template.
 */
export async function getAgentPrompt(
  templateName: string,
  agentPath: string,
): Promise<string> {
  const fullPath = getAgentPath(templateName, agentPath);
  return fs.readFile(fullPath, "utf-8");
}

/**
 * Save agent prompt content to a template.
 */
export async function saveAgentPrompt(
  templateName: string,
  agentPath: string,
  content: string,
): Promise<void> {
  const fullPath = getAgentPath(templateName, agentPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

/**
 * Install default templates from the bundled templates directory.
 * Installs new templates and updates existing ones if bundled version is newer.
 */
export async function installDefaultTemplates(): Promise<void> {
  await ensureTemplatesDir();

  // Path to bundled templates (relative to compiled dist/stores/)
  const bundledDir = path.join(__dirname, "..", "..", "templates", "workflows");

  let templateDirs: string[];
  try {
    templateDirs = await fs.readdir(bundledDir);
  } catch {
    console.log("[templates] No bundled templates directory found");
    return;
  }

  for (const dirName of templateDirs) {
    // Skip non-directories (like workflow.schema.json)
    const dirPath = path.join(bundledDir, dirName);
    const stat = await fs.stat(dirPath).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }

    const workflowPath = path.join(dirPath, "workflow.json");

    try {
      const content = await fs.readFile(workflowPath, "utf-8");
      const bundledTemplate = JSON.parse(content) as WorkflowTemplate;
      const name = bundledTemplate.name || dirName;

      // Normalize bundled version to semver
      const bundledVersion = typeof bundledTemplate.version === "number"
        ? legacyVersionToSemver(bundledTemplate.version as unknown as number)
        : bundledTemplate.version || "1.0.0";

      // Check if template already exists
      const existing = await getWorkflow(name);
      const targetDir = getTemplateDir(name);

      // Always sync changelog (even if template version unchanged)
      const bundledChangelogPath = path.join(dirPath, "changelog.md");
      try {
        const changelogContent = await fs.readFile(bundledChangelogPath, "utf-8");
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "changelog.md"), changelogContent);
      } catch {
        // No changelog in bundled template, that's ok
      }

      if (existing) {
        // Compare versions - update if bundled is newer
        const existingVersion = typeof existing.version === "number"
          ? legacyVersionToSemver(existing.version as unknown as number)
          : existing.version || "1.0.0";

        const upgradeType = getUpgradeType(existingVersion, bundledVersion);
        if (!upgradeType) {
          console.log(`[templates] Template "${name}" is up to date (${existingVersion})`);
          continue;
        }

        console.log(`[templates] Updating template "${name}" from ${existingVersion} to ${bundledVersion}`);
      }

      // Install or update the template files
      await fs.mkdir(targetDir, { recursive: true });
      await fs.mkdir(path.join(targetDir, "agents"), { recursive: true });

      // Copy workflow.json
      await fs.writeFile(
        getWorkflowPath(name),
        JSON.stringify(bundledTemplate, null, 2),
      );

      // Copy agents directory if it exists
      const bundledAgentsDir = path.join(dirPath, "agents");
      try {
        const agentFiles = await fs.readdir(bundledAgentsDir);
        for (const agentFile of agentFiles) {
          const agentContent = await fs.readFile(
            path.join(bundledAgentsDir, agentFile),
            "utf-8",
          );
          await fs.writeFile(
            path.join(targetDir, "agents", agentFile),
            agentContent,
          );
        }
      } catch {
        // No agents directory, that's ok
      }

      // Update registry (upsert)
      const registeredEntry = getStore().getTemplateByName(name);
      const isFirstTemplate = getStore().listTemplates().length === 0;

      if (registeredEntry) {
        getStore().updateTemplate(registeredEntry.id, {
          version: bundledVersion,
          description: bundledTemplate.description,
        });
      } else {
        getStore().registerTemplate({
          name,
          version: bundledVersion,
          description: bundledTemplate.description,
          isDefault: isFirstTemplate,
        });
      }

      console.log(`[templates] ${existing ? "Updated" : "Installed"} template "${name}" (${bundledVersion})`);
    } catch (err) {
      console.error(
        `[templates] Error installing template from ${dirName}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Get template for a project, preferring local copy over global catalog.
 * Falls back to global if no local copy exists.
 */
export async function getTemplateForProject(
  projectId: string
): Promise<WorkflowTemplate | null> {
  const project = await getProjectById(projectId);
  if (!project?.template) {
    return null;
  }

  // Try project-local first
  if (await hasProjectTemplate(projectId)) {
    return getProjectTemplate(projectId);
  }

  // Fall back to global catalog
  return getWorkflow(project.template.name);
}

/**
 * Get template with full phases (Ideas, Blocked, Done injected) for a project.
 */
export async function getTemplateWithFullPhasesForProject(
  projectId: string
): Promise<WorkflowTemplate | null> {
  const template = await getTemplateForProject(projectId);
  if (!template) return null;

  // Inject Ideas at start, Done at end. "Blocked" is no longer a phase -
  // superseded by the per-ticket `blocked` flag (bright red outline,
  // toggled in place), which doesn't strand a ticket out of its real
  // position in the pipeline the way moving it to a separate column did.
  const ideasPhase: Phase = {
    id: "Ideas",
    name: "Ideas",
    description: "Tickets start here",
    workers: [],
    transitions: { next: template.phases[0]?.id || "Done", manual: true },
  };

  const donePhase: Phase = {
    id: "Done",
    name: "Done",
    description: "Ticket completed",
    workers: [],
    transitions: { next: null },
  };

  return {
    ...template,
    phases: [ideasPhase, ...template.phases, donePhase],
  };
}

/**
 * Get agent prompt for a project, preferring override > local > global.
 *
 * Lookup order:
 * 1. Project override: agents/{agentType}.override.md
 * 2. Project standard: agents/{agentType}.md
 * 3. Global catalog: templates/{templateName}/agents/{agentType}.md
 */
export async function getAgentPromptForProject(
  projectId: string,
  agentPath: string
): Promise<string> {
  // 1. Try project override first
  if (await hasProjectAgentOverride(projectId, agentPath)) {
    try {
      return await getProjectAgentOverride(projectId, agentPath);
    } catch {
      // Fall through to standard lookup (handles race condition)
    }
  }

  // 2. Try project standard agent
  if (await hasProjectTemplate(projectId)) {
    try {
      return await getProjectAgentPrompt(projectId, agentPath);
    } catch {
      // Fall through to global
    }
  }

  // 3. Fall back to global catalog
  const project = await getProjectById(projectId);
  if (!project?.template) {
    throw new Error(`Project ${projectId} has no template assigned`);
  }
  return getAgentPrompt(project.template.name, agentPath);
}

// ============================================================================
// Legacy Exports (for backward compatibility)
// ============================================================================

// Re-export listTemplates as legacy function name (returns registry entries, not workflow files)
export async function listTemplates(): Promise<RegisteredTemplate[]> {
  return getStore().listTemplates();
}

// Legacy getTemplate - renamed to getWorkflow internally but aliased here
export async function getTemplate(name: string): Promise<WorkflowTemplate | null> {
  return getWorkflow(name);
}

// Legacy getTemplateWithFullPhases - renamed internally but aliased here
export async function getTemplateWithFullPhases(
  name: string,
): Promise<WorkflowTemplate | null> {
  return getWorkflowWithFullPhases(name);
}
