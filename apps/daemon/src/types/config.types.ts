export interface TelegramConfig {
  botToken: string;
  userId: string;
  forumGroupId?: string;
  mode: 'auto' | 'webhook' | 'polling';
}

export interface SlackConfig {
  appToken: string;   // xapp-... (Socket Mode)
  botToken: string;   // xoxb-... (Web API)
  channelId?: string; // Explicit channel override. Auto-discovered if unset.
}

export interface ProvidersConfig {
  telegram?: TelegramConfig;
  slack?: SlackConfig;
}

export interface DaemonConfig {
  port: number;
  host?: string;
}

export interface GlobalConfig {
  // Keep old structure for backward compatibility
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  // New structure
  providers?: ProvidersConfig;
  daemon: DaemonConfig;
}

export interface Project {
  id: string;
  slug: string;  // URL-safe identifier
  displayName: string;
  path: string;
  registeredAt: string;
  icon?: string;
  color?: string;
  template?: {
    name: string;
    version: string; // Semver format "1.0.0"
  };
  automatedPhases?: string[];           // array of phase names that are automated
  automatedPhaseMigration?: boolean;    // true while migration is in progress
  swimlaneColors?: Record<string, string>;  // phase name -> hex color
  wipLimits?: Record<string, number>;
  branchPrefix?: string;  // Custom branch prefix (default: 'potato')
  folderId?: string | null;  // FK to folders table
}

export interface DaemonInfo {
  url: string;
  port: number;
  pid: number;
  startedAt: string;
}
