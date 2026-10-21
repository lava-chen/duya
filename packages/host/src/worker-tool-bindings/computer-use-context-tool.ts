/** Host product adapter for the computer_use_context capability. */

import { contextExecutor as capabilityExecutor } from '@duya/capabilities/OSTool/context-tool';
import { adaptCapabilityExecutor } from '@duya/host/worker-tool-bindings/os-capability-adapter';

export * from '@duya/capabilities/OSTool/context-tool';

export const contextExecutor = adaptCapabilityExecutor(capabilityExecutor);
