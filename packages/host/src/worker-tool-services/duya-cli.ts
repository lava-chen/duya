import {
  DuyaCliTool,
  type DuyaCliCommandDescriptor,
  type DuyaCliToolPort,
} from '@duya/capabilities/DuyaCliTool';

/** Compose the capability with the CLI dispatcher supplied by the worker owner. */
export function createWorkerDuyaCliTool(
  commands: readonly DuyaCliCommandDescriptor[],
  run: DuyaCliToolPort['run'],
): DuyaCliTool {
  return new DuyaCliTool({ commands, run });
}
