import { EnterPlanModeTool as CapabilityEnterPlanModeTool, type PlanFileSeedStatus } from '@duya/capabilities/mode-tools';
import { getWorkerModeSwitchService } from '@duya/host/worker-tool-services/mode-switch';
import { getEnterPlanModeToolPrompt as getPrompt } from '@duya/capabilities/mode-tools';

export type { PlanFileSeedStatus };

export function probeOrCreateEmptyPlanFile(sessionId: string): Promise<PlanFileSeedStatus> {
  return getWorkerModeSwitchService().probeOrCreateEmptyPlanFile(sessionId);
}

export function isInPlanModeState(): boolean {
  return getWorkerModeSwitchService().isReadOnlyMode();
}

export function setPlanModeState(state: boolean): void {
  getWorkerModeSwitchService().setAgentMode(state ? 'plan' : 'general');
}

export class EnterPlanModeTool extends CapabilityEnterPlanModeTool {
  constructor() {
    super(getWorkerModeSwitchService());
  }

  getPrompt(): string {
    return getPrompt();
  }
}

export const enterPlanModeTool = new EnterPlanModeTool();
