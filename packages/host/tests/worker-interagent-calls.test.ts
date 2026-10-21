import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerEvent } from '@duya/agent-protocol/worker-protocol';
import type { InteragentInvokeRequest } from '@duya/capabilities/message-session-tool';
import { createWorkerInteragentMessagingPort } from '../src/worker-tool-services/interagent-messaging.js';
import {
  getPendingInteragentCall,
  type PendingInteragentCall,
} from '../src/worker-interagent-calls.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const agentEntryPath = path.resolve(HERE, '../../agent/src/process/agent-process-entry.ts');
const agentRegistryShimPath = path.resolve(HERE, '../../agent/src/process/pending-interagent-calls.ts');
const hostServicePath = path.resolve(HERE, '../src/worker-tool-services/interagent-messaging.ts');
const hostPackagePath = path.resolve(HERE, '../package.json');
const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');

function installProcessSend(send: (message: unknown) => boolean): void {
  Object.defineProperty(process, 'send', {
    configurable: true,
    writable: true,
    value: send,
  });
}

function request(id: string, timeout = 60): InteragentInvokeRequest {
  return {
    id,
    callerSessionId: 'caller-session',
    callerAgentName: 'agent',
    targetSessionId: 'target-session',
    message: 'Please report the result.',
    mode: 'minimal',
    timeout,
  };
}

afterEach(() => {
  vi.useRealTimers();
  if (originalSendDescriptor) {
    Object.defineProperty(process, 'send', originalSendDescriptor);
  } else {
    Reflect.deleteProperty(process, 'send');
  }
});

describe('Host owns the shared inter-agent call registry', () => {
  it('routes the active Agent entry and Host service to the same Host registry export', () => {
    const entrySource = fs.readFileSync(agentEntryPath, 'utf8');
    const shimSource = fs.readFileSync(agentRegistryShimPath, 'utf8').trim();
    const serviceSource = fs.readFileSync(hostServicePath, 'utf8');
    const hostPackage = JSON.parse(fs.readFileSync(hostPackagePath, 'utf8')) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };

    expect(entrySource).toMatch(/getPendingInteragentCall\s*\}\s*from\s*['"]\.\/pending-interagent-calls\.js['"]/);
    expect(shimSource).toBe("export * from '@duya/host/worker-interagent-calls';");
    expect(serviceSource).toMatch(/from\s*['"]\.\.\/worker-interagent-calls\.js['"]/);
    expect(hostPackage.exports?.['./worker-interagent-calls']).toEqual({
      types: './dist/worker-interagent-calls.d.ts',
      import: './dist/worker-interagent-calls.js',
    });
  });

  it('resolves only the matching invocation nonce and releases the registry entry on completion', async () => {
    const sent: unknown[] = [];
    installProcessSend((message) => {
      sent.push(message);
      const invokeId = (message as { id: string }).id;
      queueMicrotask(() => {
        const pending = getPendingInteragentCall(invokeId);
        expect(pending).toBeDefined();
        expect(getPendingInteragentCall('different-nonce')).toBeUndefined();

        const text = { type: 'chat:text', sessionId: 'target-session', content: 'Found it.' } as WorkerEvent;
        const done = { type: 'chat:done', sessionId: 'target-session' } as WorkerEvent;
        pending?.events.push(text, done);
        pending?.resolveDone(done);
      });
      return true;
    });

    const result = await createWorkerInteragentMessagingPort().invoke(request('nonce-1'));

    expect(sent).toEqual([{ type: 'interagent:invoke', ...request('nonce-1') }]);
    expect(result).toEqual({
      kind: 'terminal',
      terminalEvent: { type: 'chat:done', sessionId: 'target-session' },
      events: [
        { type: 'chat:text', sessionId: 'target-session', content: 'Found it.' },
        { type: 'chat:done', sessionId: 'target-session' },
      ],
    });
    expect(getPendingInteragentCall('nonce-1')).toBeUndefined();
  });

  it('times out and unregisters the matching nonce when no terminal event arrives', async () => {
    vi.useFakeTimers();
    installProcessSend(() => true);

    const resultPromise = createWorkerInteragentMessagingPort().invoke(request('nonce-timeout', 0));
    expect(getPendingInteragentCall('nonce-timeout')).toBeDefined();

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result).toEqual({
      kind: 'terminal',
      terminalEvent: {
        type: 'chat:error',
        sessionId: 'target-session',
        message: 'interagent local timeout',
        code: 'timeout',
      },
      events: [],
    });
    expect(getPendingInteragentCall('nonce-timeout')).toBeUndefined();
  });
});
