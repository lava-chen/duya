import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolloutLogger } from '../../../src/session/rollout-logger.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
      toolNames: ['read'],
    });

    logger.recordReasoning(turn, 'I should inspect the evidence.');
    logger.recordToolUse(turn, { id: 'call_1', name: 'read', input: { file_path: 'training.log' } });
    logger.recordToolResult(turn, { id: 'call_1', result: 'epoch=5 accuracy=0.98' });
    logger.recordText(turn, 'Training completed successfully.');
    logger.completeTurn(turn);

    const rows = readFileSync(logger.getFilePath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.every((row) => typeof row.timestamp === 'string' && typeof row.type === 'string' && row.payload)).toBe(true);
    expect(rows.map((row) => row.type)).toEqual([
      'session_meta', 'world_state', 'turn_context', 'event_msg', 'response_item', 'event_msg',
      'response_item', 'response_item', 'response_item', 'event_msg', 'response_item', 'event_msg', 'event_msg',
    ]);
    expect(rows.find((row) => row.type === 'session_meta')?.payload).toMatchObject({
      base_instructions: { text: 'System instructions' },
      dynamic_tools: [{ type: 'function', name: 'read' }],
    });
    expect(rows.find((row) => row.type === 'response_item' && row.payload.type === 'function_call')?.payload)
      .toMatchObject({ call_id: 'call_1', name: 'read' });
    expect(rows.find((row) => row.type === 'response_item' && row.payload.type === 'function_call_output')?.payload)
      .toMatchObject({ call_id: 'call_1', output: 'epoch=5 accuracy=0.98' });
    expect(rows.find((row) => row.type === 'event_msg' && row.payload.type === 'task_complete')?.payload)
      .toMatchObject({ turn_id: turn.id });
  });
});
