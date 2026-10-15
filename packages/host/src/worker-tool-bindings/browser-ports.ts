/** Host-owned logger and renderer availability for the browser capability. */

import {
  configureBrowserToolLogger,
  type BrowserToolHostPorts,
} from '@duya/capabilities/BrowserTool/ports';
import { logger } from '@duya/host/worker-logger';

export const agentBrowserToolPorts: BrowserToolHostPorts = {
  isRendererAvailable: () => Boolean(process.env.DUYA_DAEMON_PORT),
  logger,
};

configureBrowserToolLogger(logger);
