/** Host product adapter for the delegated computer-use tool. */

import { decideExecutor as capabilityExecutor } from '@duya/capabilities/OSTool/ComputerUseDecideTool';
import { getDecisionService } from '@duya/host/decisions';
import { adaptCapabilityExecutor } from '@duya/host/worker-tool-bindings/os-capability-adapter';

export {
  decideDefinition,
  type ComputerUseDecideEnvelope,
} from '@duya/capabilities/OSTool/ComputerUseDecideTool';

export function isComputerUseDecideAvailable(): boolean {
  try {
    return getDecisionService().available;
  } catch {
    return false;
  }
}

export const decideExecutor = adaptCapabilityExecutor(capabilityExecutor);
