import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../db/queries/sessions', () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../../db/queries/messages', () => ({
  addMessage: vi.fn(),
}));

let parseCodexJsonlLine: typeof import('./session-writer').parseCodexJsonlLine;
let parseClaudeJsonlLine: typeof import('./session-writer').parseClaudeJsonlLine;

beforeAll(async () => {
  const mod = await import('./session-writer');
  parseCodexJsonlLine = mod.parseCodexJsonlLine;
  parseClaudeJsonlLine = mod.parseClaudeJsonlLine;
});

describe('parseCodexJsonlLine', () => {
  it('maps developer messages to system text and preserves tool call ids', () => {
    const developerLine = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-22T09:13:16.785Z',
      payload: {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'developer instructions' },
        ],
      },
    });

    const toolUseLine = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-22T09:13:20.000Z',
      payload: {
        type: 'function_call',
        id: 'call_123',
        name: 'shell',
        arguments: '{"command":"dir"}',
      },
    });

    const toolResultLine = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-02-22T09:13:21.000Z',
      payload: {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'file-a',
      },
    });

    expect(parseCodexJsonlLine(developerLine)).toMatchObject([
      {
        role: 'system',
        content: 'developer instructions',
        msg_type: 'text',
      },
    ]);

    expect(parseCodexJsonlLine(toolUseLine)).toMatchObject([
      {
        role: 'assistant',
        msg_type: 'tool_use',
        tool_call_id: 'call_123',
        tool_name: 'shell',
        tool_input: '{"command":"dir"}',
      },
    ]);

    expect(parseCodexJsonlLine(toolResultLine)).toMatchObject([
      {
        role: 'tool',
        msg_type: 'tool_result',
        tool_call_id: 'call_123',
        parent_tool_call_id: 'call_123',
        content: 'file-a',
      },
    ]);
  });
});

describe('parseClaudeJsonlLine', () => {
  it('preserves Claude tool ids for tool_use and tool_result blocks', () => {
    const assistantLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-14T10:38:11.717Z',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'call_00_eVsdPT68gzQbJx6pZFGN0043',
            name: 'Grep',
            input: { pattern: 'conductor' },
          },
        ],
      },
    });

    const userLine = JSON.stringify({
      type: 'user',
      parentUuid: 'assistant-parent',
      timestamp: '2026-05-14T10:38:32.906Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_00_eVsdPT68gzQbJx6pZFGN0043',
            content: 'Found 1 file',
          },
        ],
      },
    });

    expect(parseClaudeJsonlLine(assistantLine)).toMatchObject([
      {
        role: 'assistant',
        msg_type: 'tool_use',
        tool_call_id: 'call_00_eVsdPT68gzQbJx6pZFGN0043',
        tool_name: 'Grep',
        tool_input: '{"pattern":"conductor"}',
      },
    ]);

    expect(parseClaudeJsonlLine(userLine)).toMatchObject([
      {
        role: 'tool',
        msg_type: 'tool_result',
        tool_call_id: 'call_00_eVsdPT68gzQbJx6pZFGN0043',
        parent_tool_call_id: 'call_00_eVsdPT68gzQbJx6pZFGN0043',
        content: 'Found 1 file',
      },
    ]);
  });
});
