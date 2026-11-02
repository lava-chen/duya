import { afterEach, describe, expect, it, vi } from 'vitest';

const hostPorts = vi.hoisted(() => ({
  listSessions: vi.fn(),
  readMessages: vi.fn(),
  forkAt: vi.fn(),
  submitInput: vi.fn(),
  readInputReceipt: vi.fn(),
  acquireControlLease: vi.fn(),
  releaseControlLease: vi.fn(),
  readControlLease: vi.fn(),
  spawn: vi.fn(),
  listChildren: vi.fn(),
  getChild: vi.fn(),
  reply: vi.fn(),
  cancel: vi.fn(),
  rename: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../../src/worker-db-client.js', () => ({
  sessionAppDb: {
    listSessions: hostPorts.listSessions,
    readMessages: hostPorts.readMessages,
    forkAt: hostPorts.forkAt,
  },
  sessionInputDb: {
    submit: hostPorts.submitInput,
    readReceipt: hostPorts.readInputReceipt,
    acquireControlLease: hostPorts.acquireControlLease,
    releaseControlLease: hostPorts.releaseControlLease,
    readControlLease: hostPorts.readControlLease,
  },
  sessionSpawnDb: {
    spawn: hostPorts.spawn,
    list: hostPorts.listChildren,
    get: hostPorts.getChild,
    reply: hostPorts.reply,
    cancel: hostPorts.cancel,
    rename: hostPorts.rename,
  },
  sessionDb: { search: hostPorts.search },
}));

const [{ createDuyaAppMcpServerConfig }, { MCPManager }, { withAppToolContext }] = await Promise.all([
  import('../../src/worker-tool-bindings/session-app.js'),
  import('@duya/capabilities/MCP/MCPManager'),
  import('@duya/capabilities'),
]);

describe('Host-owned duya_app Session MCP', () => {
  afterEach(() => vi.clearAllMocks());

  it('discovers the Session tool family and successfully calls session_list through MCP', async () => {
    hostPorts.listSessions.mockResolvedValue({
      sessions: [{
        session: {
          id: 'child-session',
          title: 'untrusted title',
          projectName: 'project',
          status: 'completed',
          parentSessionId: 'caller-session',
          createdAt: 1,
          updatedAt: 2,
        },
        timelineCount: 4,
      }],
      nextCursor: null,
    });
    const manager = new MCPManager();

    await manager.addServer(createDuyaAppMcpServerConfig());
    const tools = manager.getClient('duya_app')?.getTools().map((tool) => tool.name).sort() ?? [];
    const expectedTools = [
      'session_list',
      'session_spawn',
      'session_get',
      'session_reply',
      'session_cancel',
      'session_rename',
      'session_search',
      'session_read',
      'session_fork',
      'session_send',
      'session_status',
      'session_control',
    ].sort();
    try {
      const result = await withAppToolContext(
        { options: { sessionId: 'caller-session' } },
        () => manager.callTool('duya_app', 'session_list', { scope: 'children' }),
      );

      expect(tools).toEqual(expectedTools);
      expect(hostPorts.listSessions).toHaveBeenCalledWith({
        scope: 'children',
        includeArchived: false,
        limit: 10,
      });
      expect(result.error).toBeUndefined();
      expect(result.structured).toMatchObject({
        sessions: [{ sessionId: 'child-session', status: 'completed' }],
        nextCursor: null,
      });
    } finally {
      await manager.disconnectAll();
    }
  });
});
