/** Compatibility adapter for the legacy Agent import path. */
import { CLI_DESCRIPTORS } from '@duya/cli/contract';
import {
  DuyaCliTool as CapabilityDuyaCliTool,
  type DuyaCliCommandDescriptor,
  type DuyaCliToolPort,
} from '@duya/capabilities/DuyaCliTool';
import { createWorkerDuyaCliTool } from '@duya/host/worker-tool-services/duya-cli';
import { runCliCommand } from './runner.js';

const commands: readonly DuyaCliCommandDescriptor[] = CLI_DESCRIPTORS.map((descriptor) => ({
  name: descriptor.name,
  ...(descriptor.subcommands
    ? { subcommands: Object.keys(descriptor.subcommands) }
    : {}),
}));

const defaultPort: DuyaCliToolPort = { commands, run: runCliCommand };

export class DuyaCliTool extends CapabilityDuyaCliTool {
  constructor(port: DuyaCliToolPort = defaultPort) {
    super(port);
  }
}

export const duyaCliTool = createWorkerDuyaCliTool(commands, runCliCommand);
