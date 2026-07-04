import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageSessionTool } from '../MessageSessionTool.js';

// Mock the agent-process-entry exports used by MessageSessionTool.
vi.mock('../../../process/agent-process-entry.js', () => ({
  registerPendingInteragentCall: vi.fn(),
  unregisterPendingInteragentCall: vi.fn(),
}));

describe('MessageSessionTool', () => {
  let tool: MessageSessionTool;

  beforeEach(() => {
    tool = new MessageSessionTool();
    // Reset process.send between tests. process.send is undefined when
    // not running as a child_process (the default in vitest). Use
    // defineProperty so we can overwrite the non-writable NodeJS property.
    Object.defineProperty(process, 'send', { value: undefined, configurable: true });
  });

  it('has correct name and schema', () => {
    expect(tool.name).toBe('MessageSession');
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        targetSessionId: expect.any(Object),
        message: expect.any(Object),
      }),
      required: ['targetSessionId', 'message'],
    });
  });

  it('returns error when process.send is not available', async () => {
    // process.send is undefined (set in beforeEach)
    const result = await tool.execute({ targetSessionId: 'B', message: 'hi' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('process.send not available');
  });

  it('sends interagent:invoke via process.send', async () => {
    const sendMock = vi.fn();
    Object.defineProperty(process, 'send', { value: sendMock, configurable: true });

    // Don't await — we'll let it hang since no event arrives
    const promise = tool.execute({ targetSessionId: 'B', message: 'hi', timeout: 1 });

    // Verify process.send was called with the right shape
    await new Promise((r) => setTimeout(r, 50));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'interagent:invoke',
        targetSessionId: 'B',
        message: 'hi',
        mode: 'minimal',
        timeout: 1,
      }),
    );

    // The promise should resolve after the local timeout fires
    // (no chat:done / chat:error event arrives in this test).
    // localTimer = (timeout + 5) * 1000 = 6s.
    const result = await promise;
    expect(result.error).toBe(true);
    expect(result.result).toContain('timeout');
  });
});
