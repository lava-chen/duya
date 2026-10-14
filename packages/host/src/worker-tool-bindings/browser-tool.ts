/** Compatibility adapter for the Host-owned browser host ports. */

import {
  BrowserTool as CapabilityBrowserTool,
  type BrowserInput,
} from '@duya/capabilities/BrowserTool/BrowserTool';
import type { DomainBlockerConfig } from '@duya/capabilities/BrowserTool/DomainBlocker';
import { agentBrowserToolPorts } from '@duya/host/worker-tool-bindings/browser-ports';

export class BrowserTool extends CapabilityBrowserTool {
  constructor(domainBlockerConfig?: DomainBlockerConfig) {
    super(agentBrowserToolPorts, domainBlockerConfig);
  }
}

export const browserTool = new BrowserTool();
export default BrowserTool;
export type { BrowserInput };
