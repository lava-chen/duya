export interface LenientValidationWarning {
  field: string;
  message: string;
}

export interface ValidatedCapability {
  name: string;
  file: string;
  description?: string;
}

export interface ValidatedHook {
  event: string;
  handler: string;
}

export interface ValidatedCapabilities {
  commands: ValidatedCapability[];
  skills: ValidatedCapability[];
  agents: ValidatedCapability[];
  hooks: ValidatedHook[];
}

export interface BestEffortManifest {
  schemaVersion?: string;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: { name: string; url?: string };
  entry?: { type: string; main: string };
  capabilities?: Record<string, unknown>;
  permissions?: Array<{ name: string; scope?: string; domains?: string[] }>;
  engines?: { duya?: string; node?: string };
}

export interface LenientValidationResult {
  valid: boolean;
  warnings: LenientValidationWarning[];
  manifest: BestEffortManifest;
  capabilities: ValidatedCapabilities;
  agentContext: string;
  complete: boolean;
}

export interface PluginMarkdownFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: { name: string; url?: string };
  commands?: ValidatedCapability[];
  skills?: ValidatedCapability[];
  agents?: ValidatedCapability[];
  hooks?: ValidatedHook[];
  agent_context?: string;
}

export interface PluginMarkdownParseResult {
  frontmatter: PluginMarkdownFrontmatter | null;
  body: string;
  rawFrontmatter: Record<string, unknown>;
}