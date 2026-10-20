/**
 * Display projection tests.
 *
 * The failure under test is a DUPLICATED ANSWER: the durable history catching up
 * with a turn the live surface is still streaming. These cases build a real
 * `RunSession`, project it against a real durable page, and count rows — which
 * is the only way to notice a second copy of the same sentence appearing below
 * the first one.
 */

import { describe, expect, it } from 'vitest';
import { RunSession } from '@duya/client-core';
import { projectConversation, type ConversationRow } from '../../src/client/conversation.js';
import type { DurableMessageRow } from '../../src/client/api.js';
import {
  messageFinalized,
  resetClock,
  RUN_ID,
  SESSION_ID,
  textDelta,
  toolCompleted,
  toolStarted,
  turnCompleted,
  turnStarted,
} from './fixtures.js';

function historyRow(overrides: Partial<DurableMessageRow> & { readonly id: string }): DurableMessageRow {
  return {
    createdAt: 1_700_000_000_000,
    turnId: null,
    role: 'assistant',
    text: '',
    thinking: '',
    ...overrides,
  };
}

function texts(rows: readonly ConversationRow[]): readonly string[] {
  return rows.filter((row) => row.kind === 'assistant' || row.kind === 'user').map((row) => row.text);
}

describe('projectConversation', () => {
  it('draws an assistant answer once when the selected run already streams it', () => {
    resetClock();
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    session.acceptWindow([
      turnStarted(1),
      textDelta(2, 'msg-1', '正在读取文件'),
      messageFinalized(3, 'msg-1', '文件里写着：构建通过。'),
      turnCompleted(4),
    ]);
    // The durable page has caught up and now holds the same answer.
    const rows = projectConversation({
      messages: [
        historyRow({ id: 'm-user-1', role: 'user', text: '看看文件', turnId: 'turn-1', createdAt: 1_699_999_999_000 }),
        historyRow({ id: 'm-assistant-1', role: 'assistant', text: '文件里写着：构建通过。', runId: RUN_ID, turnId: 'c51-legacy-turn-id', createdAt: 1_700_000_000_500 }),
      ],
      compactions: [],
      snapshot: session.getSnapshot(),
    });

    expect(texts(rows)).toEqual(['看看文件', '文件里写着：构建通过。']);
    expect(rows.filter((row) => row.kind === 'assistant' && row.text === '文件里写着：构建通过。')).toHaveLength(1);
  });

  it('draws durable answers from turns the selected run does not own', () => {
    resetClock();
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    session.acceptWindow([turnStarted(1), messageFinalized(2, 'msg-new', '这一轮的回答'), turnCompleted(3)]);

    const rows = projectConversation({
      messages: [
        historyRow({ id: 'm-user-0', role: 'user', text: '上一轮的问题', turnId: 'turn-0', createdAt: 1_699_999_000_000 }),
        historyRow({ id: 'm-assistant-0', role: 'assistant', text: '上一轮的回答', runId: 'previous-run', turnId: 'turn-0', createdAt: 1_699_999_500_000 }),
        historyRow({ id: 'm-user-1', role: 'user', text: '这一轮的问题', turnId: 'turn-1', createdAt: 1_700_000_000_000 }),
        historyRow({ id: 'm-assistant-1', role: 'assistant', text: '这一轮的回答', runId: RUN_ID, turnId: 'turn-1', createdAt: 1_700_000_001_000 }),
      ],
      compactions: [],
      snapshot: session.getSnapshot(),
    });

    expect(texts(rows)).toEqual(['上一轮的问题', '上一轮的回答', '这一轮的问题', '这一轮的回答']);
  });

  it('joins durable finals by run id when legacy turn ids do not match', () => {
    resetClock();
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    session.acceptWindow([
      turnStarted(1),
      messageFinalized(2, 'msg-current', '同一条最终回答'),
      turnCompleted(3),
    ]);

    const rows = projectConversation({
      messages: [
        historyRow({
          id: 'm-current-run',
          runId: RUN_ID,
          turnId: 'c51-legacy-turn-id',
          text: '同一条最终回答',
        }),
        historyRow({
          id: 'm-other-run',
          runId: 'another-run',
          turnId: 'run-1:turn:1',
          text: '同一条最终回答',
        }),
        historyRow({
          id: 'm-legacy',
          turnId: 'run-1:turn:2',
          text: '旧数据仍展示',
        }),
      ],
      compactions: [],
      snapshot: session.getSnapshot(),
    });

    expect(rows.filter((row) => row.kind === 'assistant' && row.text === '同一条最终回答')).toHaveLength(2);
    expect(rows.map((row) => row.kind === 'assistant' ? row.key : row.kind))
      .toContain('assistant:m-other-run');
    expect(rows.map((row) => row.kind === 'assistant' ? row.key : row.kind))
      .toContain('assistant:m-legacy');
    expect(rows.map((row) => row.kind === 'assistant' ? row.key : row.kind))
      .toContain('live-assistant:msg-current');
  });

  it('shows the finalized text once, never the streamed text appended to it', () => {
    resetClock();
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    session.acceptWindow([
      turnStarted(1),
      textDelta(2, 'msg-1', '结论是'),
      textDelta(3, 'msg-1', '通过'),
      messageFinalized(4, 'msg-1', '结论是通过'),
    ]);

    const rows = projectConversation({ messages: [], compactions: [], snapshot: session.getSnapshot() });
    const answers = rows.filter((row) => row.kind === 'assistant');

    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe('结论是通过');
    expect(answers[0]?.finalized).toBe(true);
  });

  it('orders live text and tool cards the way the run produced them', () => {
    resetClock();
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    session.acceptWindow([
      turnStarted(1),
      textDelta(2, 'msg-1', '先看一下。'),
      toolStarted(3),
      toolCompleted(4),
      // A second answer after a tool call is a NEW message id: the finalized
      // event replaces the text of the message it names, and reusing msg-1 would
      // overwrite the first answer instead of following it.
      messageFinalized(5, 'msg-2', '看完了。'),
    ]);

    const rows = projectConversation({
      messages: [historyRow({ id: 'm-user-1', role: 'user', text: '看一下', turnId: 'turn-1' })],
      compactions: [],
      snapshot: session.getSnapshot(),
    });

    // Joined rather than compared as an array: a failed diff full of Chinese
    // text is unreadable in a terminal, and the order is the whole point here.
    expect(rows.map((row) => row.kind).join(',')).toBe('user,assistant,tool,assistant');
    expect(rows[1]?.text).toBe('先看一下。');
    expect(rows[2]?.kind === 'tool' ? rows[2].tool.name : '').toBe('read_file');
    expect(rows[3]?.text).toBe('看完了。');
  });

  it('falls back to the durable page alone when no run is selected', () => {
    const rows = projectConversation({
      messages: [
        historyRow({ id: 'm-user-1', role: 'user', text: '问题', turnId: 'turn-1' }),
        historyRow({ id: 'm-assistant-1', role: 'assistant', text: '回答', turnId: 'turn-1' }),
      ],
      compactions: [{ id: 'c-1', createdAt: 1_700_000_002_000, tokensBefore: 90_000, tokensAfter: 12_000 }],
      snapshot: null,
    });

    expect(texts(rows)).toEqual(['问题', '回答']);
    expect(rows.some((row) => row.kind === 'compaction')).toBe(true);
  });
});
