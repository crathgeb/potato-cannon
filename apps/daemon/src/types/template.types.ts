// src/types/template.types.ts

// Worker types
export type WorkerType = "agent" | "ralphLoop" | "taskLoop" | "answerBot";

export interface BaseWorker {
  id: string;
  type: WorkerType;
  description?: string;
}

/**
 * Model specification - either a string shortcut/ID or an object with provider info.
 * String format: "haiku", "sonnet", "opus" (shortcuts) or "claude-sonnet-4-20250514" (explicit ID)
 * Object format: { id: "claude-sonnet-4-20250514", provider: "anthropic" }
 */
export type ModelSpec = string | { id: string; provider?: string };

export interface AgentWorker extends BaseWorker {
  type: "agent";
  source: string;
  disallowTools?: string[];
  model?: ModelSpec;
  // When true, this phase resumes the ticket's most recent Claude session
  // (via --resume) instead of spawning a fresh one with a full context
  // dump. For a real spec-kit ticket, this is what lets Specify -> Clarify
  // -> Plan -> Tasks -> Analyze -> Implement be one continuous session
  // that actually remembers everything, the way spec-kit itself assumes -
  // rather than disconnected phase-agents reconstructing context from
  // written artifacts each time (which is what caused the worktree/
  // directory mismatch bug: those artifacts lived in a different worktree
  // than the one a later phase created). Every other Cannon workflow
  // (product-development, homesflow-sdd) leaves this unset and is
  // unaffected - fresh-spawn-per-phase stays the default.
  resumePrevious?: boolean;
}

export interface AnswerBotWorker extends BaseWorker {
  type: "answerBot";
  source: string;
  model?: ModelSpec;
}

export interface RalphLoopWorker extends BaseWorker {
  type: "ralphLoop";
  maxAttempts: number;
  workers: Worker[];
}

export interface TaskLoopWorker extends BaseWorker {
  type: "taskLoop";
  maxAttempts: number;
  workers: Worker[]; // Cannot contain TaskLoopWorker
}

export type Worker = AgentWorker | AnswerBotWorker | RalphLoopWorker | TaskLoopWorker;

// Phase types
export interface Transitions {
  next: string | null;
  manual?: boolean;
}

export interface Phase {
  id: string;
  name: string;
  description: string;
  workers: Worker[];
  transitions: Transitions;
  requiresWorktree?: boolean;
}

// Template types
export interface WorkflowTemplate {
  name: string;
  description: string;
  version: string; // Semver format "1.0.0"
  phases: Phase[];
}

export interface TemplateRegistryEntry {
  name: string;
  version: string; // Semver format "1.0.0"
  isDefault: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateRegistry {
  templates: TemplateRegistryEntry[];
}

export interface ProjectTemplateRef {
  name: string;
  version: string; // Semver format "1.0.0"
}

// Type guards
export function isAgentWorker(worker: Worker): worker is AgentWorker {
  return worker.type === "agent";
}

export function isRalphLoopWorker(worker: Worker): worker is RalphLoopWorker {
  return worker.type === "ralphLoop";
}

export function isTaskLoopWorker(worker: Worker): worker is TaskLoopWorker {
  return worker.type === "taskLoop";
}

export function isAnswerBotWorker(worker: Worker): worker is AnswerBotWorker {
  return worker.type === "answerBot";
}
