/** Compatibility adapter for the legacy Agent import path. */
import {
  PlanTool as CapabilityPlanTool,
  PLAN_TOOL_NAME,
  type PlanToolContext,
} from '@duya/capabilities/PlanTool/PlanTool';
import type { PlanStoragePort } from '@duya/capabilities/PlanTool/ports';
import { createWorkerPlanPort } from '@duya/host/worker-tool-services/plan';

export { PLAN_TOOL_NAME, type PlanToolContext };

export class PlanTool extends CapabilityPlanTool {
  constructor(port: PlanStoragePort = createWorkerPlanPort()) {
    super(port);
  }
}

export const planTool = new PlanTool();
