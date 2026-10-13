/**
 * Compatibility adapter for Agent-owned process lifecycle services.
 *
 * The tool implementation lives in `@duya/capabilities`; the Agent layer
 * supplies its managed-process registry, cancellation, notifications, and
 * application output directory through ports.
 */

import {
  BashTool as CapabilityBashTool,
  type ShellCommandToolConfig,
} from '@duya/capabilities';
import type { ShellCommandRuntimePorts } from '@duya/capabilities/ShellCommandTool/ports';
import { getBashOutputDir } from '../../utils/duyaRoot.js';

const agentShellRuntimePorts: ShellCommandRuntimePorts = {
  start: async (params) => (await import('./managed-bash.js')).startManagedBash(params),
  outputDirectory: getBashOutputDir,
  gitReminder: async (command) => (await import('./git-reminder.js')).buildGitReminder(command),
};

export class BashTool extends CapabilityBashTool {
  constructor(config: Partial<ShellCommandToolConfig> = {}) {
    super(agentShellRuntimePorts, config);
  }
}

export {
  buildSanitizedBashEnv,
  truncateShellOutput,
  validateBashInput,
  BASH_MAX_OUTPUT_CHARS,
  BASH_MAX_OUTPUT_LINES,
} from '@duya/capabilities';
export type {
  BashToolInput,
  ShellCommandToolConfig,
  TruncatedShellOutput,
} from '@duya/capabilities';
