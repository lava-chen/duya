import {
  SwitchModeTool as CapabilitySwitchModeTool,
  ALL_MODES,
  type AgentMode,
} from '@duya/capabilities/mode-tools';
import { getWorkerModeSwitchService } from '@duya/host/worker-tool-services/mode-switch';
import { getSwitchModeToolPrompt as getPrompt } from '@duya/capabilities/mode-tools';

export { ALL_MODES };
export type { AgentMode };
export type ValidMode = AgentMode;

export function getCurrentMode(): AgentMode {
  return getWorkerModeSwitchService().getCurrentMode();
}

export function setAgentMode(mode: AgentMode): void {
  getWorkerModeSwitchService().setAgentMode(mode);
}

export function isReadOnlyMode(): boolean {
  return getWorkerModeSwitchService().isReadOnlyMode();
}

export class SwitchModeTool extends CapabilitySwitchModeTool {
  constructor() {
    super(getWorkerModeSwitchService());
  }

  getPrompt(): string {
    return getPrompt();
  }
}

export const switchModeTool = new SwitchModeTool();
