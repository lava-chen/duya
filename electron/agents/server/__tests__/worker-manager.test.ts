import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerEnvironment } from '../worker-manager';

const originalDaemonPort = process.env.DUYA_DAEMON_PORT;

afterEach(() => {
  if (originalDaemonPort === undefined) delete process.env.DUYA_DAEMON_PORT;
  else process.env.DUYA_DAEMON_PORT = originalDaemonPort;
});

describe('createWorkerEnvironment', () => {
  it('passes the Browser Daemon port to Agent Server workers', () => {
    delete process.env.DUYA_DAEMON_PORT;

    const env = createWorkerEnvironment('session-1', 2048, 'C:/duya/better-sqlite3');

    expect(env.DUYA_AGENT_MODE).toBe('true');
    expect(env.DUYA_AGENT_SERVER).toBe('true');
    expect(env.DUYA_DAEMON_PORT).toBe('19825');
  });

  it('preserves an explicitly configured Browser Daemon port', () => {
    process.env.DUYA_DAEMON_PORT = '24567';

    const env = createWorkerEnvironment('session-2', 1024, 'C:/duya/better-sqlite3');

    expect(env.DUYA_DAEMON_PORT).toBe('24567');
  });
});
