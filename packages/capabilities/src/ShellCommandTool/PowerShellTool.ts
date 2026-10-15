import { BashTool, type ShellCommandToolConfig } from './BashTool.js';
import type { ShellCommandRuntimePorts } from './ports.js';
import {
  checkPowerShellSecurity,
  isReadOnlyPowerShellCommand,
} from './PowerShellSecurity.js';

export const DEFAULT_POWERSHELL_TOOL_CONFIG: ShellCommandToolConfig = {
  name: 'powershell',
  description: 'Execute a PowerShell command. Returns the stdout and stderr output.',
  providerKind: 'powershell',
  commandLabel: 'PowerShell command',
  securityCheck: checkPowerShellSecurity,
  readOnlyCheck: isReadOnlyPowerShellCommand,
  normalizeCommandForExecution: (command) => command,
};

/**
 * PowerShell specialization of the shared shell capability. Its caller supplies
 * process lifecycle, cancellation, and output persistence through runtime ports.
 */
export class PowerShellTool extends BashTool {
  constructor(
    runtime: ShellCommandRuntimePorts,
    config: Partial<ShellCommandToolConfig> = {},
  ) {
    super(runtime, { ...DEFAULT_POWERSHELL_TOOL_CONFIG, ...config });
  }
}

export { checkPowerShellSecurity, isReadOnlyPowerShellCommand } from './PowerShellSecurity.js';
