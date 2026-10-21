/** Host product adapter for the capability-owned computer_cua tool. */

import { executor as capabilityExecutor } from '@duya/capabilities/OSTool/ComputerCuaTool';
import { adaptCapabilityExecutor } from '@duya/host/worker-tool-bindings/os-capability-adapter';

export * from '@duya/capabilities/OSTool/ComputerCuaTool';

export const executor = adaptCapabilityExecutor(capabilityExecutor);
