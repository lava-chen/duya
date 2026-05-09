// index.ts - Export all types

export * from './message';
export * from './stream';
export * from './slash-command';
export * from './automation';

// Extended thread type with project support
export interface Thread {
  id: string;
  title: string;
  workingDirectory: string | null;
  projectName: string | null;
  createdAt: number;
  updatedAt: number;
}

// Project group for sidebar display
export interface ProjectGroup {
  workingDirectory: string;
  projectName: string;
  threadCount: number;
  lastActivity: number;
}

// App settings interface (used by useSettings hook)
export interface SummaryLLMConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  apiKey: string;
  model: string;
  baseURL?: string;
}

export interface VisionLLMConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

// MCP Server configuration
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface AppSettings {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  lastSelectedModel: string; // User's last selected model, remembered across sessions
  mcpServers: MCPServerConfig[];
  permissionMode: "default" | "bypass" | "auto" | "dontAsk";
  sandboxEnabled: boolean;
  theme: "dark" | "light" | "system";
  locale: string;
  provider: string;
  messageFont: "serif" | "sans-serif";
  skillAdditionalPaths: string[];
  skillNudgeInterval: number;
  summaryLLMConfig: SummaryLLMConfig | null;
  summaryLLMEnabled: boolean;
  databasePath: string;
  // Code display settings
  showLineNumbers: boolean;
  wordWrap: boolean;
  // Notification settings
  notificationsEnabled: boolean;
  soundEffectsEnabled: boolean;
  // Vision model settings
  visionLLMConfig: VisionLLMConfig | null;
  visionLLMEnabled: boolean;
  // Gateway model settings
  gatewayModel: string;
  // Appearance settings
  font?: string;
  compactMode?: boolean;
  showTimestamps?: boolean;
  showAvatars?: boolean;
  // Browser security settings
  blockedDomains: string[];
  // Favorite agent profiles for quick access (max 3)
  favoriteAgentIds: string[];
  // Agent prompt language preference (e.g. 'Chinese', 'English')
  agentLanguage?: string;
}
