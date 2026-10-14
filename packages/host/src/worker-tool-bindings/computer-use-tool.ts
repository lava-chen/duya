/** Host product adapter for the capability-owned computer_use tool. */

import { executor as capabilityExecutor } from '@duya/capabilities/OSTool/ComputerUseTool';
import { adaptCapabilityExecutor } from '@duya/host/worker-tool-bindings/os-capability-adapter';

export * from '@duya/capabilities/OSTool/ComputerUseTool';

export const executor = adaptCapabilityExecutor(capabilityExecutor);
