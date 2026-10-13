import {
  PowerShellTool as CapabilityPowerShellTool,
  type ShellCommandRuntimePorts,
} from '@duya/capabilities';
import { getBashOutputDir } from '../../utils/duyaRoot.js';

const agentPowerShellRuntimePorts: ShellCommandRuntimePorts = {
  start: async (params) => (await import('../BashTool/managed-bash.js')).startManagedBash(params),
  outputDirectory: getBashOutputDir,
  gitReminder: async (command) => (await import('../BashTool/git-reminder.js')).buildGitReminder(command),
};

/** Temporary compatibility adapter for the existing Agent registry. */
export class PowerShellTool extends CapabilityPowerShellTool {
  constructor() {
    super(agentPowerShellRuntimePorts);
  }
}
