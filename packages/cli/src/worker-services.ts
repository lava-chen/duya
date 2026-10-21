import { CLI_DESCRIPTORS, buildAgentRunner } from './contract/index.js';
import { createWorkerDuyaCliTool } from '@duya/host/worker-tool-services/duya-cli';
import { createWorkerProcessAssembly } from '@duya/host/worker-process-assembly';
const resolveCommand = buildAgentRunner();
export const duyaCliTool = createWorkerDuyaCliTool(
  CLI_DESCRIPTORS.map((descriptor) => ({ name: descriptor.name, ...(descriptor.subcommands ? { subcommands: Object.keys(descriptor.subcommands) } : {}) })),
  async (invocation) => {
    try { return await resolveCommand(invocation); }
    catch (error) { return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
  },
);
export const workerProcessAssembly = createWorkerProcessAssembly({ duyaCliTool });
