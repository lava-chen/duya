import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { reserveCheckoutTask, bindCheckoutTaskPid, releaseCheckoutTask, hasBackgroundCheckoutLease } from '../../src/workspace/task-leases.js';
import { tempDir } from './fixtures.js';

describe('durable checkout process leases', () => {
  it('retains unknown dispatches, observes a real process and releases only its own intent', async () => {
    const data = tempDir('duya-task-lease-');
    const cwd = tempDir('duya-task-cwd-');
    const a = reserveCheckoutTask({ taskId: 'a', cwd }, data);
    const b = reserveCheckoutTask({ taskId: 'b', cwd }, data);
    expect(hasBackgroundCheckoutLease(cwd, data)).toBe(true);
    expect(hasBackgroundCheckoutLease(tempDir('duya-unrelated-'), data)).toBe(false);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      bindCheckoutTaskPid(a, child.pid!, data);
      releaseCheckoutTask(b, data);
      expect(hasBackgroundCheckoutLease(cwd, data)).toBe(true);
    } finally {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
    expect(hasBackgroundCheckoutLease(cwd, data)).toBe(false);
    releaseCheckoutTask(a, data);
  });

  it('fails closed on a corrupt durable record', () => {
    const data = tempDir('duya-corrupt-lease-');
    const id = reserveCheckoutTask({ taskId: 'task', cwd: data }, data);
    releaseCheckoutTask(id, data);
    const directory = path.join(data, 'bash-outputs', 'checkout-leases');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'corrupt.json'), '{');
    expect(() => hasBackgroundCheckoutLease(data, data)).toThrow(/unreadable/);
  });
});
