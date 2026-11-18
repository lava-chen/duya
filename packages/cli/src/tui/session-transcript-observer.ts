import type { RunId, SessionId } from '@duya/agent-protocol';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { LegacyFrame } from './blocks.js';
import { RemoteSessionWatch } from './remote-session-watch.js';

export function observeSessionTranscript(options: {
  client: Pick<HostSessionHttpClient, 'listAgentRunsBySession' | 'watchAgentRunEvents'>;
  id: string;
  intervalMs: number;
  load: (activeRuns?: ReadonlySet<RunId>) => Promise<void>;
  push: (frame: LegacyFrame) => void;
}): () => void {
  const watch = new RemoteSessionWatch({
    client: options.client,
    sessionId: options.id as SessionId,
    isPaused: () => false,
    isLocalRun: () => false,
    loadHistory: options.load,
    onFrame: options.push,
    onNotice: (message) => {
      if (message.includes('waiting for approval') || message.startsWith('Could not')) {
        options.push({ type: 'error', data: { message } });
      }
    },
    onRunSettled: () => options.load().catch(() => {}),
  });
  const timer = setInterval(() => { void watch.poll(); }, options.intervalMs);
  timer.unref();
  void watch.poll();
  return () => {
    clearInterval(timer);
    watch.stop();
  };
}
