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
const hostEntryPath = path.resolve(HERE, '../src/worker-process-entry.ts');
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
    // The ACTIVE entry is the Host's. The worker entry moved out of
    // packages/agent, and the agent-side file is now a thin adapter onto it
    // -- so the registry is read by `packages/host/src/worker-process-entry.ts`
    // and the agent entry inherits that routing through the adapter.
    const entrySource = fs.readFileSync(hostEntryPath, 'utf8');
    const agentEntrySource = fs.readFileSync(agentEntryPath, 'utf8');
    const shimSource = fs.readFileSync(agentRegistryShimPath, 'utf8').trim();
    const serviceSource = fs.readFileSync(hostServicePath, 'utf8');
    const hostPackage = JSON.parse(fs.readFileSync(hostPackagePath, 'utf8')) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };

    // The entry reads the registry through the PACKAGE export -- the same
    // export the agent-side shim re-exports and the package declares.
    expect(entrySource).toMatch(/getPendingInteragentCall\s*\}\s*from\s*['"]@duya\/host\/worker-interagent-calls['"]/);
    // The agent entry is that adapter, so it cannot own a second registry.
    expect(agentEntrySource).toMatch(/export \* from '@duya\/host\/worker-process-entry'/);
    expect(shimSource).toBe("export * from '@duya/host/worker-interagent-calls';");
    expect(serviceSource).toMatch(/from\s*['"]\.\.\/worker-interagent-calls\.js['"]/);
    expect(hostPackage.exports?.['./worker-interagent-calls']).toEqual({
      types: './dist/worker-interagent-calls.d.ts',
      import: './dist/worker-interagent-calls.js',
    });
  });

  it('resolves the package export and the relative import to ONE registry module', async () => {
    // The claim the row above states in SOURCE SHAPE, checked in RUNTIME
    // IDENTITY: two spellings of the same registry have to be the same
    // module, or the entry and the service would each own a private `Map`
    // and a registered call would never be found again.
    //
    // The source-shape row cannot see this: it proves both sides NAME the
    // export, not that they GET it.
    const viaPackage = await import('@duya/host/worker-interagent-calls');
    const viaRelative = await import('../src/worker-interagent-calls.js');

    expect(viaPackage.getPendingInteragentCall).toBe(viaRelative.getPendingInteragentCall);
    expect(viaPackage.registerPendingInteragentCall).toBe(viaRelative.registerPendingInteragentCall);
    expect(viaPackage.unregisterPendingInteragentCall).toBe(viaRelative.unregisterPendingInteragentCall);
    // And the module this file already imports statically is that same one.
    expect(getPendingInteragentCall).toBe(viaRelative.getPendingInteragentCall);
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
