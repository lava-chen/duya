/** Bind the capability to Host product services. */
import {
  SessionTool as CapabilitySessionTool,
  type SessionToolPort,
} from '@duya/capabilities/session-tool';
import { createWorkerSessionManagementPort } from '@duya/host/worker-tool-services/session-management';

export type {
  SessionSpawnDetails,
  SessionSpawnOperation,
  SessionSpawnSession,
} from '@duya/capabilities/session-tool';

export class SessionTool extends CapabilitySessionTool {
  constructor(port: SessionToolPort = createWorkerSessionManagementPort()) {
    super(port);
  }
}

export const sessionTool = new SessionTool();
