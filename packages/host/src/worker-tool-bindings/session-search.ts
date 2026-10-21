/** Bind the capability to Host product services. */
import {
  SessionSearchTool as CapabilitySessionSearchTool,
  type SessionSearchPort,
  type SummaryLLMConfig,
} from '@duya/capabilities/session-search-tool';
import { createWorkerSessionSearchPort } from '@duya/host/worker-tool-services/session-search';

export { DESCRIPTION, SESSION_SEARCH_TOOL_NAME } from '@duya/capabilities/session-search-tool';
export type { SummaryLLMConfig } from '@duya/capabilities/session-search-tool';

export class SessionSearchTool extends CapabilitySessionSearchTool {
  constructor(port: SessionSearchPort = createWorkerSessionSearchPort()) {
    super(port);
  }
}

export const sessionSearchTool = new SessionSearchTool();
