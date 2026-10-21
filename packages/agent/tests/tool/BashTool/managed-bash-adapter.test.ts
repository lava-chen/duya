import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createProcessScope, type ProcessScope, type ProcessSpawner } from '@duya/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = {
  register: vi.fn(),
  markKilled: vi.fn(),
  markCompleted: vi.fn(),
  markAutoPromoted: vi.fn(),
};
const { sendBackgroundNotificationMock } = vi.hoisted(() => ({
  sendBackgroundNotificationMock: vi.fn(),
}));

vi.mock('../../../src/session/bash-task-registry.js', () => ({
  getBashTaskRegistry: () => registry,
}));
vi.mock('../../../src/utils/duyaRoot.js', () => ({
  getBashOutputDir: () => outputDirectory,
}));
vi.mock('../../../src/lifecycle/mailboxBackgroundNotification.js', () => ({
  sendBackgroundNotification: sendBackgroundNotificationMock,
}));

const { startManagedBash } = await import('../../../src/tool/BashTool/managed-bash.js');
let outputDirectory: string;

class FakeChild extends EventEmitter {
  constructor(public pid: number | undefined) {
    super();
  }
}

function fakeScope(): { scope: ProcessScope; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn: ProcessSpawner = () => {
    const child = new FakeChild(4242);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { scope: createProcessScope({ killTree: vi.fn(), spawnFn }), children };
}

describe('Agent managed-bash compatibility adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outputDirectory = mkdtempSync(join(tmpdir(), 'duya-agent-shell-adapter-'));
  });

  afterEach(() => {
    rmSync(outputDirectory, { recursive: true, force: true });
  });

  it('keeps the legacy mailbox transport while delegating process ownership to Host', async () => {
    const { scope, children } = fakeScope();
    const handle = await startManagedBash({
      taskId: 'task-1',
      command: 'echo adapter',
      shellPath: 'sh',
      shellArgs: ['-c', 'echo adapter'],
      cwd: process.cwd(),
      env: process.env,
      foregroundTimeoutMs: 60_000,
      sessionId: 'session-1',
      scope,
    });

    children[0]?.emit('close', 0);
    await handle.settled;
    await vi.waitFor(() => expect(sendBackgroundNotificationMock).toHaveBeenCalledTimes(1));

    expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-1',
      status: 'running',
    }));
    expect(sendBackgroundNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      taskId: 'task-1',
      xml: expect.stringContaining('<task-notification>'),
    }));
  });
});
