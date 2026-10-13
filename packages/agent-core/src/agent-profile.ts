/** Prompt section overrides carried by an agent profile. */
export interface PromptProfileOverride {
  /** Disable specific prompt sections. */
  disableSections?: string[];
  /**
   * @deprecated Prefer `disableSections`. Still honored for DB-persisted
   * custom profiles; presets must not use it.
   */
  enableSections?: string[];
}

export type AgentProfileKind = 'main' | 'subagent' | 'special';

/** Pure profile contract used to compose an agent's prompt and tool scope. */
export interface AgentProfile {
  /** Unique identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Description of the agent's purpose. */
  description?: string;
  /** Allowed tool group patterns, including wildcards such as `file:*`. */
  allowedTools?: string[];
  /** Denied tool group patterns. */
  disallowedTools?: string[];
  /** Default model ID override. */
  defaultModel?: string;
  /** Prompt section controls. */
  promptProfile?: PromptProfileOverride;
  /** Prompt system id; open for systems registered by other packages. */
  promptSystem?: 'general' | 'code' | 'research' | 'gateway' | (string & {});
  /** Preset-only identity prompt that replaces the generic agent identity. */
  identityPrompt?: string;
  /** Additional instructions loaded from config for custom agents. */
  globalInstructions?: string;
  /** Whether this profile is selectable by users. */
  userVisible: boolean;
  /** Whether this is a preset profile. */
  isPreset: boolean;
  /** Whether this profile is enabled. */
  isEnabled: boolean;
  /** Profile grouping used by the UI and runtime. */
  kind?: AgentProfileKind;
  /** Creation timestamp. */
  createdAt: number;
  /** Last update timestamp. */
  updatedAt: number;
}
