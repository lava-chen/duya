import { createBotRegistry as createHostRegistry } from '@duya/host/worker-tools/bot-builtin';
import { duyaCliTool } from './DuyaCliTool/index.js';
type LegacyRegistryArgs = Parameters<typeof createHostRegistry> extends [unknown, ...infer Rest] ? Rest : never;
export function createBotRegistry(...args: LegacyRegistryArgs) { return createHostRegistry({ duyaCliTool }, ...args); }
import { registerBotTools as registerHostBotTools } from '@duya/host/worker-tools/bot-builtin';
export function registerBotTools(...args: [Parameters<typeof registerHostBotTools>[0], Parameters<typeof registerHostBotTools>[1]]) { return registerHostBotTools(...args, { duyaCliTool }); }
