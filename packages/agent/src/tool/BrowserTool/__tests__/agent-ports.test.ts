import { afterEach, describe, expect, it } from 'vitest';

import { agentBrowserToolPorts } from '../agent-ports.js';

describe('Agent browser capability host ports', () => {
  const originalDaemonPort = process.env.DUYA_DAEMON_PORT;

  afterEach(() => {
    if (originalDaemonPort === undefined) {
      delete process.env.DUYA_DAEMON_PORT;
    } else {
      process.env.DUYA_DAEMON_PORT = originalDaemonPort;
    }
  });

  it('reports renderer availability from the Agent daemon port', () => {
    delete process.env.DUYA_DAEMON_PORT;
    expect(agentBrowserToolPorts.isRendererAvailable()).toBe(false);

    process.env.DUYA_DAEMON_PORT = '43120';
    expect(agentBrowserToolPorts.isRendererAvailable()).toBe(true);
  });
});
