/** Narrow CLI metadata and dispatch surface consumed by the capability. */
export interface DuyaCliCommandDescriptor {
  name: string;
  subcommands?: readonly string[];
}

/** Normalized invocation understood by the in-process CLI dispatcher. */
export interface DuyaCliInvocation {
  command: string;
  subcommand?: string;
  id?: string;
  format?: string;
  yes?: boolean;
  extraArgs?: string[];
  cwd?: string;
  fromFile?: string;
  cronBodyJson?: string;
  prompt?: string;
  platform?: string;
  limit?: string;
  offset?: string;
  configId?: string;
  configName?: string;
  configType?: string;
  configBaseUrl?: string;
  configApiKey?: string;
  configActive?: boolean;
  configEnabled?: boolean;
  configModel?: string;
  configProvider?: string;
  configMaxTokens?: string;
  configTemperature?: string;
  configTopP?: string;
  configTopK?: string;
  configEnableThinking?: boolean;
  configThinkingBudget?: string;
  configCode?: string;
  configUser?: string;
  configStyleId?: string;
  configInclude?: string;
  configClear?: boolean;
  configArgs?: string[];
  configEnv?: string[];
  configAgents?: string[];
  agentId?: string;
  agentName?: string;
  agentDescription?: string;
  agentWorkspace?: string;
  agentModel?: string;
  agentInstructionsFile?: string;
  agentToolsProfile?: string;
  agentAllow?: string[] | string;
  agentDeny?: string[] | string;
  agentPlugins?: string[] | string;
  enabled?: boolean;
  verbose?: boolean;
  fromPath?: string;
  scope?: string;
  deleteData?: boolean;
}

export interface DuyaCliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runtime data required by the tool is supplied by the composition owner.
 * Capabilities owns validation, argv normalization, and the result envelope;
 * the injected dispatcher owns the actual CLI command effects.
 */
export interface DuyaCliToolPort {
  commands: readonly DuyaCliCommandDescriptor[];
  run(invocation: DuyaCliInvocation): Promise<DuyaCliRunResult>;
}
