import {
  MemoryWriteTool as CapabilityMemoryWriteTool,
  type MemoryToolFilePort,
  validateMemoryContent,
} from '@duya/capabilities';
import { nodeMemoryToolFilePort } from '@duya/host/worker-tool-bindings/memory-files';

export class MemoryWriteTool extends CapabilityMemoryWriteTool {
  constructor(files: MemoryToolFilePort = nodeMemoryToolFilePort) {
    super(files);
  }
}

export { validateMemoryContent };
