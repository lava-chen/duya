import { ExitPlanModeTool as CapabilityExitPlanModeTool } from '@duya/capabilities/mode-tools';
import { getWorkerModeSwitchService } from '@duya/host/worker-tool-services/mode-switch';
import { getExitPlanModeToolPrompt as getPrompt } from '@duya/capabilities/mode-tools';

export class ExitPlanModeTool extends CapabilityExitPlanModeTool {
  constructor() {
    super(getWorkerModeSwitchService());
  }

  getPrompt(): string {
    return getPrompt();
  }
}

export const exitPlanModeTool = new ExitPlanModeTool();
