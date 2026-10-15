import {
  PowerShellTool as CapabilityPowerShellTool,
  type ShellCommandRuntimePorts,
} from '@duya/capabilities';
import { getManagedShellOutputDirectory } from '@duya/host/managed-shell/paths';

const agentPowerShellRuntimePorts: ShellCommandRuntimePorts = {
  start: async (params) => (await import('@duya/host/managed-shell/bound-shell')).startManagedBash(params),
  outputDirectory: getManagedShellOutputDirectory,
  gitReminder: async (command) => (await import('@duya/host/managed-shell/git-reminder')).buildGitReminder(command),
};

/** Temporary compatibility adapter for the existing Agent registry. */
export class PowerShellTool extends CapabilityPowerShellTool {
  constructor() {
    super(agentPowerShellRuntimePorts);
  }
}
