import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCurationAgent, type CurationRunnerPool } from '../curation_agent_runner';
import { CURATOR_SYSTEM_PROMPT, buildCuratorInitialMessage } from '@duya/agent';

/**
 * Minimal mock pool implementing only the surface the runner uses.
 * `onMessage` handlers are invoked by emitting 'chat:done' / 'chat:error'
 * via `emitDone` / `emitError`.
 */
function createMockPool(): CurationRunnerPool & { emitDone: () => void; emitError: (msg: string) => void; sent: unknown[]; } {
  const handlers = new Map<string, Set<(msg: { type: string }) => void>>();
  const sent: unknown[] = [];
  const pool: CurationRunnerPool & { emitDone: () => void; emitError: (msg: string) => void; sent: unknown[] } = {
    acquire: vi.fn().mockResolvedValue({ isNew: true }),
    send: vi.fn().mockImplementation((sessionId: string, msg: unknown) => {
      sent.push({ sessionId, msg });
      return true;
    }),
    onMessage: vi.fn().mockImplementation((sessionId: string, handler: (msg: { type: string }) => void) => {
      let set = handlers.get(sessionId);
      if (!set) {
        set = new Set();
        handlers.set(sessionId, set);
      }
      set.add(handler);
    }),
    removeMessageHandler: vi.fn().mockImplementation((sessionId: string, handler?: (msg: { type: string }) => void) => {
      const set = handlers.get(sessionId);
      if (set && handler) set.delete(handler);
      else handlers.delete(sessionId);
    }),
    releaseAndWait: vi.fn().mockResolvedValue(undefined),
    sent,
    emitDone: () => {
      const set = handlers.get('curator-session');
      if (set) for (const h of set) h({ type: 'chat:done' });
    },
    emitError: (msg: string) => {
      const set = handlers.get('curator-session');
      if (set) for (const h of set) h({ type: 'chat:error', message: msg } as { type: string });
    },
  };
  return pool;
}

function writeReceipt(stagingDir: string, runId: string): void {
  fs.writeFileSync(
    path.join(stagingDir, 'curation_receipt.json'),
    JSON.stringify({
      run_id: runId,
      inputs: [
        {
          input_kind: 'rollout',
          input_key: 'r-1',
          content_hash: 'hash-1',
          disposition: 'absorbed',
          note: 'ok',
        },
      ],
      files_changed: ['items/preference/x.md'],
      policy_proposal: null,
      layout_changed: false,
      health: { added: 1, merged: 0, retired: 0, no_change: 0, rejected: 0 },
    }),
  );
}

describe('runCurationAgent', () => {
  let stagingDir: string;

  beforeEach(() => {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-runner-'));
  });
  afterEach(() => {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  it('1. normal completion — sends init + chat:start, reads receipt, returns it', async () => {
    const pool = createMockPool();
    writeReceipt(stagingDir, 'run-42');

    // Emit chat:done shortly after acquire resolves.
    setTimeout(() => pool.emitDone(), 20);

    const result = await runCurationAgent({
      pool,
      sessionId: 'curator-session',
      stagingDir,
      runId: 'run-42',
      inputs: [{ inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' }],
      providerConfig: {
        apiKey: 'test-key',
        model: 'test-model',
        provider: 'anthropic',
      },
      systemLocation: '/home/user/project',
      timeoutMs: 5000,
    });

    expect(result.receipt.run_id).toBe('run-42');
    expect(result.receipt.inputs[0].disposition).toBe('absorbed');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // init was sent first.
    const initCall = pool.sent.find((c) => (c as { msg: { type: string } }).msg.type === 'init');
    expect(initCall).toBeDefined();
    expect((initCall as { msg: { workingDirectory: string; providerConfig: { model: string } } }).msg.workingDirectory).toBe('/home/user/project');
    expect((initCall as { msg: { providerConfig: { model: string } } }).msg.providerConfig.model).toBe('test-model');

    // chat:start was sent with curator options.
    const startCall = pool.sent.find((c) => (c as { msg: { type: string } }).msg.type === 'chat:start');
    expect(startCall).toBeDefined();
    const startMsg = (startCall as { msg: { prompt: string; options: { systemPrompt: string; allowedTools: string[]; agentProfileId: string; mode: string; excludeFromStage1: boolean } } }).msg;
    expect(startMsg.options.systemPrompt).toBe(CURATOR_SYSTEM_PROMPT);
    expect(startMsg.options.allowedTools).toEqual(['read', 'write', 'edit', 'grep', 'glob']);
    expect(startMsg.options.agentProfileId).toBe('memory-curator');
    expect(startMsg.options.mode).toBe('automation');
    expect(startMsg.options.excludeFromStage1).toBe(true);
    expect(startMsg.prompt).toContain('r-1');
    expect(startMsg.prompt).toContain('hash-1');

    // releaseAndWait was called.
    expect(pool.releaseAndWait).toHaveBeenCalledWith('curator-session', expect.objectContaining({ gracefulMs: expect.any(Number) }));
  });

  it('2. timeout — throws, releaseAndWait still called, receipt not read', async () => {
    const pool = createMockPool();
    // Never emit chat:done → runner times out.

    await expect(
      runCurationAgent({
        pool,
        sessionId: 'curator-session',
        stagingDir,
        runId: 'run-42',
        inputs: [{ inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' }],
        providerConfig: { apiKey: 'k', model: 'm', provider: 'anthropic' },
        systemLocation: '/p',
        timeoutMs: 50, // very short
      }),
    ).rejects.toThrow(/timeout|timed out/i);

    expect(pool.releaseAndWait).toHaveBeenCalled();
  });

  it('3. chat:error from agent — throws with agent message, releaseAndWait called', async () => {
    const pool = createMockPool();
    setTimeout(() => pool.emitError('agent crashed'), 20);

    await expect(
      runCurationAgent({
        pool,
        sessionId: 'curator-session',
        stagingDir,
        runId: 'run-42',
        inputs: [],
        providerConfig: { apiKey: 'k', model: 'm', provider: 'anthropic' },
        systemLocation: '/p',
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/agent crashed/);

    expect(pool.releaseAndWait).toHaveBeenCalled();
  });

  it('4. missing receipt after chat:done — throws (agent crashed before writing)', async () => {
    const pool = createMockPool();
    // No receipt written.
    setTimeout(() => pool.emitDone(), 20);

    await expect(
      runCurationAgent({
        pool,
        sessionId: 'curator-session',
        stagingDir,
        runId: 'run-42',
        inputs: [{ inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' }],
        providerConfig: { apiKey: 'k', model: 'm', provider: 'anthropic' },
        systemLocation: '/p',
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/curation_receipt\.json/);

    expect(pool.releaseAndWait).toHaveBeenCalled();
  });

  it('5. init + chat:start use the curated system prompt + initial message', async () => {
    const pool = createMockPool();
    writeReceipt(stagingDir, 'run-99');
    setTimeout(() => pool.emitDone(), 20);

    await runCurationAgent({
      pool,
      sessionId: 'curator-session',
      stagingDir,
      runId: 'run-99',
      inputs: [
        { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
        { inputKind: 'ad_hoc', inputKey: 'extensions/ad_hoc/n.md', contentHash: 'hash-2' },
      ],
      providerConfig: { apiKey: 'k', model: 'm', provider: 'anthropic' },
      systemLocation: '/p',
      timeoutMs: 5000,
    });

    const startCall = pool.sent.find((c) => (c as { msg: { type: string } }).msg.type === 'chat:start') as { msg: { prompt: string } };
    const expectedPrompt = buildCuratorInitialMessage(
      stagingDir,
      [
        { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
        { inputKind: 'ad_hoc', inputKey: 'extensions/ad_hoc/n.md', contentHash: 'hash-2' },
      ],
      'run-99',
    );
    expect(startCall.msg.prompt).toBe(expectedPrompt);
  });

  it('6. releaseAndWait always called even on success (finally block)', async () => {
    const pool = createMockPool();
    writeReceipt(stagingDir, 'run-1');
    setTimeout(() => pool.emitDone(), 20);

    await runCurationAgent({
      pool,
      sessionId: 'curator-session',
      stagingDir,
      runId: 'run-1',
      inputs: [],
      providerConfig: { apiKey: 'k', model: 'm', provider: 'anthropic' },
      systemLocation: '/p',
      timeoutMs: 5000,
    });

    // Exactly one releaseAndWait call.
    expect(pool.releaseAndWait).toHaveBeenCalledTimes(1);
    // Message handler was cleaned up (no leak).
    expect(pool.removeMessageHandler).toHaveBeenCalledWith('curator-session', expect.any(Function));
  });

  it('7. chat:start options object declares excludeFromStage1: true (contract test)', async () => {
    const pool = createMockPool();
    writeReceipt(stagingDir, 'run-contract');
    setTimeout(() => pool.emitDone(), 20);

    await runCurationAgent({
      pool,
      sessionId: 'curator-session',
      stagingDir,
      runId: 'run-contract',
      inputs: [],
      providerConfig: { apiKey: 'k', model: 'm', provider: 'anthropic' },
      systemLocation: '/p',
      timeoutMs: 5000,
    });

    const startCall = pool.sent.find((c) => (c as { msg: { type: string } }).msg.type === 'chat:start') as {
      msg: { options: { excludeFromStage1: boolean; mode: string; agentProfileId: string } };
    };
    expect(startCall.msg.options.excludeFromStage1).toBe(true);
    expect(startCall.msg.options.mode).toBe('automation');
    expect(startCall.msg.options.agentProfileId).toBe('memory-curator');
  });
});