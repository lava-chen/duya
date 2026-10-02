/**
 * BotActivityIndicator — derive/label logic tests.
 *
 * The component's pill permanence and roll animation are CSS/DOM concerns;
 * what is worth pinning here is the ACTIVITY SEMANTICS: which line shows
 * for which stream snapshot, and the traps found in review —
 *   - the pill never hides (derive never returns null)
 *   - a stale thinking tail must NOT show right after a tool result
 *     (the thinking buffer retains the previous block)
 *   - tools read as semantic verbs, not raw names
 */

import { describe, expect, it } from 'vitest';
import {
  activityKey,
  deriveBotActivity,
  summarizeToolInput,
  toolLabel,
} from '../BotActivityIndicator';
import type { SessionStreamSnapshot } from '@/types/message';

function snap(overrides: Partial<SessionStreamSnapshot> = {}): SessionStreamSnapshot {
  return {
    sessionId: 's1',
    phase: 'starting',
    streamingContent: '',
    toolUses: [],
    toolResults: [],
    ...overrides,
  } as SessionStreamSnapshot;
}

describe('deriveBotActivity', () => {
  it('never returns null — unknown moments fall back to 正在处理', () => {
    expect(deriveBotActivity(snap())).toEqual({ kind: 'working', label: '正在处理' });
    expect(deriveBotActivity(snap({ phase: 'tool_use' }))).toEqual({
      kind: 'working',
      label: '正在处理',
    });
  });

  it('maps error and permission phases to dedicated lines', () => {
    expect(deriveBotActivity(snap({ error: 'boom', phase: 'error' }))).toMatchObject({
      kind: 'error',
      label: '遇到错误',
    });
    expect(deriveBotActivity(snap({ phase: 'awaiting_permission' }))).toMatchObject({
      kind: 'waiting',
      label: '等待确认',
    });
  });

  it('shows the newest UNRESOLVED tool call with a semantic verb + input summary', () => {
    const a = deriveBotActivity(
      snap({
        phase: 'tool_use',
        toolUses: [
          { id: 't1', name: 'Bash', input: { command: 'npm run test' } },
          { id: 't2', name: 'Read', input: { file_path: 'src/App.tsx' } },
        ],
        toolResults: [{ tool_use_id: 't1', content: 'ok' }],
      }),
    );
    expect(a.kind).toBe('tool');
    expect(a.label).toBe('读取文件');
    expect(a.detail).toBe('src/App.tsx');
  });

  it('prefers the active tool over reply text and thinking (priority order)', () => {
    const a = deriveBotActivity(
      snap({
        phase: 'streaming',
        streamingContent: 'partial reply',
        streamingThinkingContent: 'stale thought',
        toolUses: [{ id: 't1', name: 'Grep', input: { pattern: 'foo' } }],
      }),
    );
    expect(a.label).toBe('搜索内容');
  });

  it('shows 正在回复 when the bot streams its message body', () => {
    expect(
      deriveBotActivity(snap({ phase: 'streaming', streamingContent: 'hello' })),
    ).toEqual({ kind: 'reply', label: '正在回复' });
  });

  it('shows the thinking tail only while streaming — NOT after a tool result (stale buffer)', () => {
    // Streaming with thinking and no reply text → thinking line.
    expect(
      deriveBotActivity(
        snap({ phase: 'streaming', streamingThinkingContent: 'step one\nstep two' }),
      ),
    ).toEqual({ kind: 'thinking', label: '正在思考', detail: 'step two' });

    // Same thinking buffer but phase is tool_use (result just landed) →
    // the stale tail must not surface; neutral line instead.
    expect(
      deriveBotActivity(
        snap({ phase: 'tool_use', streamingThinkingContent: 'stale thought' }),
      ),
    ).toEqual({ kind: 'working', label: '正在处理' });
  });

  it('maps the persistence window to 正在保存', () => {
    expect(deriveBotActivity(snap({ phase: 'persisting' }))).toEqual({
      kind: 'working',
      label: '正在保存',
    });
  });
});

describe('toolLabel', () => {
  it('maps known tools to semantic verbs regardless of case', () => {
    expect(toolLabel('Bash')).toBe('运行命令');
    expect(toolLabel('WebSearch')).toBe('搜索网页');
    expect(toolLabel('computer_use')).toBe('操作电脑');
    expect(toolLabel('SendMessage')).toBe('发送消息');
    expect(toolLabel('Task')).toBe('派出子代理');
  });

  it('falls back to the formatted name for unknown tools', () => {
    expect(toolLabel('mcp__foo__bar')).toBe('Mcp Foo Bar');
  });
});

describe('summarizeToolInput', () => {
  it('picks the most telling scalar field in priority order', () => {
    expect(summarizeToolInput({ command: 'ls -la', file_path: '/x' })).toBe('ls -la');
    expect(summarizeToolInput({ file_path: '/a/b.ts', pattern: 'x' })).toBe('/a/b.ts');
    expect(summarizeToolInput({ prompt: 'do it\nthen that' })).toBe('do it then that');
  });

  it('ellipsizes long values', () => {
    const long = 'x'.repeat(80);
    expect(summarizeToolInput({ command: long })).toBe('x'.repeat(56) + '…');
  });
});

describe('activityKey', () => {
  it('changes when any part of the line changes', () => {
    const base = { kind: 'tool' as const, label: '读取文件' };
    expect(activityKey(base)).toBe(activityKey({ ...base }));
    expect(activityKey(base)).not.toBe(activityKey({ ...base, detail: 'a' }));
    expect(activityKey(base)).not.toBe(activityKey({ ...base, label: '运行命令' }));
  });
});
