import type {
  InteragentInvokeRequest,
  MessageSessionInvocationResult,
  MessageSessionPort,
} from '@duya/capabilities/message-session-tool';
import type { WorkerEvent } from '@duya/agent-protocol/worker-protocol';
import {
  registerPendingInteragentCall,
  unregisterPendingInteragentCall,
  type PendingInteragentCall,
} from '../worker-interagent-calls.js';

/** Owns the worker process IPC and pending-call lifetime for MessageSession. */
export function createWorkerInteragentMessagingPort(): MessageSessionPort {
  return {
    getCallerSessionId(contextSessionId) {
      return contextSessionId || process.env.SESSION_ID || 'unknown';
    },
    async invoke(request: InteragentInvokeRequest): Promise<MessageSessionInvocationResult> {
      let resolveDone!: (event: WorkerEvent) => void;
      let resolveError!: (event: WorkerEvent) => void;
      const donePromise = new Promise<WorkerEvent>((resolve) => { resolveDone = resolve; });
      const errorPromise = new Promise<WorkerEvent>((resolve) => { resolveError = resolve; });

      let localTimer: ReturnType<typeof setTimeout> | undefined;
      const timerPromise = new Promise<WorkerEvent>((resolve) => {
        localTimer = setTimeout(() => {
          resolve({
            type: 'chat:error',
            sessionId: request.targetSessionId,
            message: 'interagent local timeout',
            code: 'timeout',
          } as WorkerEvent);
        }, (request.timeout + 5) * 1000);
      });

      const call: PendingInteragentCall = {
        events: [],
        resolveDone,
        resolveError,
        timer: localTimer!,
      };
      registerPendingInteragentCall(request.id, call);

      if (!process.send) {
        unregisterPendingInteragentCall(request.id);
        clearTimeout(call.timer);
        return { kind: 'unavailable' };
      }

      process.send({ type: 'interagent:invoke', ...request });

      try {
        const terminalEvent = await Promise.race([donePromise, errorPromise, timerPromise]);
        return { kind: 'terminal', terminalEvent, events: call.events };
      } finally {
        clearTimeout(call.timer);
        unregisterPendingInteragentCall(request.id);
      }
    },
  };
}
