/**
 * Compatibility export for legacy Agent consumers. The implementation belongs
 * to Host, and this adapter supplies the Agent process logger.
 */
import { logger } from '@duya/host/worker-logger';
import {
  getOSContextBridge as getHostOSContextBridge,
  injectOSContextFragment as injectHostOSContextFragment,
  type OSContextBridge,
  type OSContextLogger,
} from '@duya/host/worker-os-context';

export * from '@duya/host/worker-os-context';

const agentOSContextLogger: OSContextLogger = logger;

export function getOSContextBridge(): OSContextBridge {
  return getHostOSContextBridge(agentOSContextLogger);
}

type InjectableMessage = {
  id?: string;
  content: string | ReadonlyArray<{ type: string }>;
};

export function injectOSContextFragment(
  messages: InjectableMessage[],
  runtimePromptMessageId: string | null,
  bridge?: Parameters<typeof injectHostOSContextFragment>[2],
): boolean {
  return injectHostOSContextFragment(
    messages,
    runtimePromptMessageId,
    bridge ?? getOSContextBridge(),
  );
}
