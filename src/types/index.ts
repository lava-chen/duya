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
  allowedAgentIds?: string[];
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
  // Wiki Agent model settings
  wikiAgentModel?: string;
  // Wiki Agent feature toggle (experimental)
  wikiAgentEnabled?: boolean;
  // Title generation model
  titleGenerationModel?: string;
  // Appearance settings
  font?: string;
  compactMode?: boolean;
  messageFontSize?: 'small' | 'medium' | 'large';
  // Browser security settings
  blockedDomains: string[];
  // Browser backend mode: auto (degradation chain) | extension | built-in
  browserBackendMode?: 'auto' | 'extension' | 'built-in';
  // Built-in browser default home URL
  browserHomeUrl?: string;
  // Built-in browser default download directory
  browserDownloadPath?: string;
  // Favorite agent profiles for quick access (max 3)
  favoriteAgentIds: string[];
  // Agent prompt language preference (e.g. 'Chinese', 'English')
  agentLanguage?: string;
  // Security settings
  securityScanEnabled: boolean;
  cronPermissionMode?: "default" | "bypass" | "auto";
  /**
   * Permission mode applied to sessions created by the IM gateway
   * (Feishu / WeChat / Telegram / QQ). Independent from `permissionMode`
   * (desktop chat) so users can keep desktop strict while relaxing (or
   * tightening) IM-channel access without coupling them. Falls back to
   * `permissionMode` when unset.
   */
  gatewayPermissionMode?: "default" | "bypass" | "auto";
  // Default workspace directory for creating new projects
  workspaceDir?: string;
}
