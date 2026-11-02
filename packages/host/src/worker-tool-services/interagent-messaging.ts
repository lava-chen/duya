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

      const call: PendingInteragentCall = {
        events: [],
        resolveDone,
        resolveError,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      registerPendingInteragentCall(request.id, call);

      let localTimer: ReturnType<typeof setTimeout> | undefined;
      const timerPromise = new Promise<WorkerEvent>((resolve) => {
        localTimer = setTimeout(() => {
          // Nothing arrived at all means the invoke never reached a handler:
          // the host dropped it. A timeout with frames on the wire means the
          // target was working and ran long. The two are different failures,
          // and saying "timeout" for both is what hid the cause of every
          // inter-agent bug this port ever had.
          const dispatched = call.events.length > 0;
          resolve({
            type: 'chat:error',
            sessionId: request.targetSessionId,
            message: dispatched
              ? 'interagent local timeout'
              : 'interagent invoke was never handled by the host',
            code: dispatched ? 'timeout' : 'not_dispatched',
          } as WorkerEvent);
        }, (request.timeout + 5) * 1000);
      });
      call.timer = localTimer!;

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
