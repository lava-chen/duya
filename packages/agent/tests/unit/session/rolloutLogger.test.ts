import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolloutLogger } from '../../../src/session/rollout-logger.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parseRows(logger: RolloutLogger): Array<Record<string, unknown>> {
  return readFileSync(logger.getFilePath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('RolloutLogger', () => {
  it('writes a Codex-style envelope for a complete tool turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-rollout-'));
    tempDirs.push(root);
    const logger = new RolloutLogger('session-1', root);
    const turn = logger.startTurn({
      cwd: 'E:/project',
      provider: 'anthropic',
      model: 'MiniMax-M3',
      systemPrompt: 'System instructions',
      userContent: 'Inspect the training log',
      permissionMode: 'default',
      tools: [{
        name: 'read',
        description: 'Read a file.',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      }],
    });

    // The next real provider request may have a different surface after
    // tool_search discovers an on-demand tool. It must be auditable without
    // resorting to provider HTTP logging.
    logger.recordProviderRequest(turn, {
      cwd: 'E:/project',
      provider: 'anthropic',
      model: 'MiniMax-M3',
      systemPrompt: 'System instructions\n\n## On-Demand Tool Guides\n\nUse bash safely.',
      userContent: 'Inspect the training log',
      permissionMode: 'default',
      tools: [
        {
          name: 'read',
          description: 'Read a file.',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
        {
          name: 'bash',
          description: 'Run a shell command.',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    });

    logger.recordReasoning(turn, 'I should inspect the evidence.');
    logger.recordToolUse(turn, { id: 'call_1', name: 'read', input: { file_path: 'training.log' } });
    logger.recordToolResult(turn, { id: 'call_1', result: 'epoch=5 accuracy=0.98' });
    logger.recordText(turn, 'Training completed successfully.');
    logger.completeTurn(turn);

    const rows = parseRows(logger);
    expect(rows.every((row) => typeof row.timestamp === 'string' && typeof row.type === 'string' && row.payload)).toBe(true);
    expect(rows.map((row) => row.type)).toEqual([
      'session_meta', 'world_state', 'turn_context', 'event_msg', 'response_item', 'event_msg',
      'event_msg',
      'response_item', 'response_item', 'response_item', 'event_msg', 'response_item', 'event_msg', 'event_msg',
    ]);

    // Codex-compatible: world_state is a full snapshot. When no AGENTS.md is
    // provided, agents_md is omitted rather than set to undefined.
    const worldState = rows.find((row) => row.type === 'world_state')?.payload;
    expect(worldState).toMatchObject({ full: true });
    expect(worldState.state.agents_md).toBeUndefined();
    expect(worldState.state.duya).toMatchObject({ rollout_schema: 'codex-compatible-v1' });

    const promptSnapshots = rows.filter((row) => row.type === 'session_meta');
    expect(promptSnapshots[0]?.payload).toMatchObject({
      base_instructions: { text: 'System instructions' },
      dynamic_tools: [{
        type: 'function',
        name: 'read',
        description: 'Read a file.',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
      }],
      duya_request_snapshot: { provider_request_index: 1, tool_count: 1 },
    });
    // Subsequent provider requests in the same turn emit a lightweight
    // event_msg/provider_request instead of repeating the full session_meta.
    const secondSnapshot = rows.find((row) => row.type === 'event_msg' && row.payload.type === 'provider_request')?.payload;
    expect(secondSnapshot).toMatchObject({
      provider_request_index: 2,
      tool_count: 2,
    });

    // The first user message contains only the actual user content.
    const userMessage = rows.find((row) => row.type === 'response_item' && row.payload.role === 'user')?.payload;
    expect(userMessage?.content).toEqual([{ type: 'input_text', text: 'Inspect the training log' }]);

    expect(rows.find((row) => row.type === 'response_item' && row.payload.type === 'function_call')?.payload)
      .toMatchObject({ call_id: 'call_1', name: 'read' });
    // Codex-compatible: output is an array of content blocks.
    expect(rows.find((row) => row.type === 'response_item' && row.payload.type === 'function_call_output')?.payload)
      .toMatchObject({ call_id: 'call_1', output: [{ type: 'input_text', text: 'epoch=5 accuracy=0.98' }] });
    // Codex-compatible: assistant message carries phase, agent_message uses `message` field.
    expect(rows.find((row) => row.type === 'response_item' && row.payload.role === 'assistant')?.payload)
      .toMatchObject({ phase: 'final' });
    expect(rows.find((row) => row.type === 'event_msg' && row.payload.type === 'agent_message')?.payload)
      .toMatchObject({ message: 'Training completed successfully.', phase: 'final', memory_citation: null });
    expect(rows.find((row) => row.type === 'event_msg' && row.payload.type === 'task_complete')?.payload)
      .toMatchObject({ turn_id: turn.id });
  });

  it('surfaces AGENTS.md as a user message and strips it from base_instructions', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-rollout-'));
    tempDirs.push(root);
    const logger = new RolloutLogger('session-2', root);
    const agentsMdText = '# Project instructions\n\nUse TypeScript strict mode.';
    const turn = logger.startTurn({
      cwd: 'E:/project',
      provider: 'anthropic',
      model: 'MiniMax-M3',
      // AGENTS.md is no longer duplicated in the system prompt; it is emitted
      // as the first user message and in world_state.
      systemPrompt: 'System instructions',
      userContent: 'Inspect the training log',
      agentsMd: { directory: 'E:/project', text: agentsMdText },
      tools: [],
    });
    logger.completeTurn(turn);

    const rows = parseRows(logger);

    const worldState = rows.find((row) => row.type === 'world_state')?.payload;
    expect(worldState).toMatchObject({
      full: true,
      state: { agents_md: { directory: 'E:/project', text: agentsMdText } },
    });

    const baseInstructions = rows.find((row) => row.type === 'session_meta')?.payload.base_instructions.text;
    expect(baseInstructions).not.toContain(agentsMdText);
    expect(baseInstructions).toContain('System instructions');

    const userMessage = rows.find((row) => row.type === 'response_item' && row.payload.role === 'user')?.payload;
    expect(userMessage?.content).toEqual([
      { type: 'input_text', text: agentsMdText },
      { type: 'input_text', text: 'Inspect the training log' },
    ]);

    expect(rows.find((row) => row.type === 'event_msg' && row.payload.type === 'task_complete')?.payload)
      .toMatchObject({ turn_id: turn.id });
  });
});
