/** Compatibility adapter for the legacy Agent import path. */
import {
  ManageRoutineTool as CapabilityManageRoutineTool,
  MAX_ROUTINES_PER_BOT,
} from '@duya/capabilities/ManageRoutineTool/ManageRoutineTool';
import type { ManageRoutinePort } from '@duya/capabilities/ManageRoutineTool/ports';
import { createWorkerManageRoutinePort } from '@duya/host/worker-tool-services/routine';

export { MAX_ROUTINES_PER_BOT };
export type { RoutineScheduleInput } from '@duya/capabilities/ManageRoutineTool/ports';

export class ManageRoutineTool extends CapabilityManageRoutineTool {
  constructor(port: ManageRoutinePort = createWorkerManageRoutinePort()) {
    super(port);
  }
}

export const manageRoutineTool = new ManageRoutineTool();
