import {
  MemoryWriteTool as CapabilityMemoryWriteTool,
  type MemoryToolFilePort,
  validateMemoryContent,
} from '@duya/capabilities';
import { nodeMemoryToolFilePort } from '../memory-tool-file-port.js';

export class MemoryWriteTool extends CapabilityMemoryWriteTool {
  constructor(files: MemoryToolFilePort = nodeMemoryToolFilePort) {
    super(files);
  }
}

export { validateMemoryContent };
