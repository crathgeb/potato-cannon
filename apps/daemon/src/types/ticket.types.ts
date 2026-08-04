// Re-export shared types and constants
export {
  DEFAULT_PHASES,
  DEFAULT_TRIGGER_PHASES,
  TERMINAL_PHASES,
} from '@potato-cannon/shared';

export type {
  Ticket,
  ArchiveResult,
  HistorySessionRecord,
  TicketHistoryEntry,
} from '@potato-cannon/shared';

/**
 * TicketPhase is a string to support dynamic phases from templates.
 * Use DEFAULT_PHASES for projects without templates.
 */
export type TicketPhase = string;

export interface CreateTicketInput {
  title: string;
  description?: string;
  ticketNumber?: string;
  epicId?: string;
}

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  phase?: TicketPhase;
  sessionId?: string;
  pendingPhase?: string | null;
  reason?: string;
  blocked?: boolean;
}

export type ArtifactType =
  | "refinement"
  | "architecture"
  | "specification"
  | "code"
  | "test"
  | "other";

export interface ArtifactVersion {
  version: number;
  savedAt: string;
  description: string;
  path?: string;
}

export interface ArtifactEntry {
  type: ArtifactType;
  description: string;
  savedAt: string;
  path?: string;
  phase?: string;
  versions: ArtifactVersion[];
}

export type ArtifactManifest = Record<string, ArtifactEntry>;

/** Flattened artifact for API responses */
export interface ArtifactListItem {
  filename: string;
  type: ArtifactType;
  description: string;
  savedAt: string;
  phase?: string;
  versionCount: number;
}

export interface TicketImage {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

export interface ConversationEntry {
  id: string;
  question: string;
  options: string[];
  askedAt: string;
  phase?: string;
  answer?: string;
  answeredAt?: string;
}

export interface TicketMessage {
  type: "question" | "user" | "notification" | "artifact";
  text: string;
  conversationId?: string;
  options?: string[];
  timestamp: string;
  // Artifact-specific fields (only present when type === 'artifact')
  artifact?: {
    filename: string;
    description?: string;
  };
}
