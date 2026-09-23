// index.ts - Export all types

export * from './message';
export * from './stream';
export * from './slash-command';
export * from './automation';
export * from './bash-task';

// Legacy UI permission toggle (Ask / Auto / Bypass). The desktop permission
// mode is now fixed to Auto (workspace-trust); the type is retained for the
// settings persistence helpers that still map UI values to stored modes.
export type PermissionMode = 'ask' | 'auto' | 'bypass';

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
  createdAt: number;
  isExpanded?: boolean;
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
  enabled: boolean;
}

// MCP Server configuration
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  allowedAgentIds?: string[];
}

export interface MemoryEntry {
  memory_id: string;
  scope: 'global' | 'project';
  project_id: string | null;
  kind: 'preference' | 'fact' | 'reference' | 'procedure' | 'person' | 'area';
  canonical_key: string;
  content: string;
  version: number;
  status: 'active' | 'superseded' | 'retired';
  created_at: number;
  updated_at: number;
}

export interface AppSettings {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  lastSelectedModel: string; // User's last selected model, remembered across sessions
  mcpServers: MCPServerConfig[];
  permissionMode: "default" | "bypass" | "auto";
  sandboxEnabled: boolean;
  theme: "dark" | "light" | "system";
  locale: string;
  provider: string;
  messageFont: "serif" | "sans-serif";
  skillAdditionalPaths: string[];
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
  // Title generation model
  titleGenerationModel?: string;
  // Appearance settings
  font?: string;
  compactMode?: boolean;
  messageFontSize?: 'small' | 'medium' | 'large';
  // Browser security settings
  blockedDomains: string[];
  // Browser backend mode: auto (degradation chain) | extension | built-in
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
  // Built-in browser default home URL
  browserHomeUrl?: string;
  // Built-in browser default download directory
  browserDownloadPath?: string;
  // Max number of pages/tabs agents may open across browser backends
  browserMaxTabs?: number;
  // Favorite agent profiles for quick access (max 3)
  favoriteAgentIds: string[];
  // Agent prompt language preference (e.g. 'Chinese', 'English')
  agentLanguage?: string;
  // Security settings
  securityScanEnabled: boolean;
  cronPermissionMode?: "default" | "bypass" | "auto";
  // Default workspace directory for creating new projects
  workspaceDir?: string;
  /**
   * Default thinking effort for new chat sessions. Persisted across sessions
   * so the last user selection carries over. `undefined` / `null` means auto.
   */
  defaultThinkingEffort?: string | null;
  // Memory system toggle
  memoryEnabled: boolean;
  // Plan 437: when true, the chat flow renders one row per plan-87 hook
  // invocation (PreToolUse, PostToolUse, UserPromptSubmit, …). When
  // false, hook events are still collected for the agent (so the model
  // sees additionalContext as before) but no UI rows appear. Default
  // ON so existing users see the new feature; toggle lives in Settings
  // → Hooks.
  showHookInvocations: boolean;
  // When true, the context ring below the input box shows detailed stats
  // by default and clicking the ring hides them. When false (default),
  // the ring shows collapsed and hovering/pin expands the stats.
  contextRingReversed?: boolean;
}
