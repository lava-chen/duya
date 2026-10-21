import {
  WriteStage1PolicyTool as CapabilityWriteStage1PolicyTool,
  type MemoryToolFilePort,
} from '@duya/capabilities';
import { nodeMemoryToolFilePort } from '@duya/host/worker-tool-bindings/memory-files';

export class WriteStage1PolicyTool extends CapabilityWriteStage1PolicyTool {
  constructor(files: MemoryToolFilePort = nodeMemoryToolFilePort) {
    super(files);
  }
}
