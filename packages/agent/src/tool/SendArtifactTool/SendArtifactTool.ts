/** Compatibility adapter for Agent consumers; outbound delivery remains host-owned. */
import * as fs from 'node:fs';
import { SendArtifactTool as CapabilitySendArtifactTool } from '@duya/capabilities/SendArtifactTool/SendArtifactTool';

export class SendArtifactTool extends CapabilitySendArtifactTool {
  constructor() {
    super({ exists: (path) => fs.existsSync(path) });
  }
}