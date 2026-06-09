import { BashTool } from '../BashTool/BashTool.js';
import {
  checkPowerShellSecurity,
  isReadOnlyPowerShellCommand,
} from './security.js';

export class PowerShellTool extends BashTool {
  constructor() {
    super({
      name: 'powershell',
      description: 'Execute a PowerShell command. Returns the stdout and stderr output.',
      providerKind: 'powershell',
      commandLabel: 'PowerShell command',
      securityCheck: checkPowerShellSecurity,
      readOnlyCheck: isReadOnlyPowerShellCommand,
      normalizeCommandForExecution: (command) => command,
    });
  }
}
