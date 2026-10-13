import {
  WriteStage1PolicyTool as CapabilityWriteStage1PolicyTool,
  type MemoryToolFilePort,
} from '@duya/capabilities';
import { nodeMemoryToolFilePort } from '../memory-tool-file-port.js';

export class WriteStage1PolicyTool extends CapabilityWriteStage1PolicyTool {
  constructor(files: MemoryToolFilePort = nodeMemoryToolFilePort) {
    super(files);
  }
}
