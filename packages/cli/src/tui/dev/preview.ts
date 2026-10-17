/** Local terminal fixture. No Host, provider credentials, or model calls. */
import { TUIApp } from '../TUIApp.js';
import { TurnQueue } from '../turn-queue.js';
import { HostEventStream } from '../host-event-stream.js';
import type { RunEvent } from '@duya/agent-protocol';

let interrupted = false;
let closed = false;
let answerPermission: ((allowed: boolean) => void) | null = null;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const queue = new TurnQueue({
  execute: async (prompt) => {
    interrupted = false;
    tui.printUser(prompt);
    if (prompt === 'bugs') {
      let seq = 0;
      const runId = 'scenario';
      // Fixed wire identity reproduces the legacy Host input; the stream
      // under test supplies each model turn's display scope.
      const events = new HostEventStream('preview', runId);
      const send = (payload: RunEvent) => {
        const frame = events.push({ sessionId: 'preview', runId, seq: ++seq, timestamp: Date.now(), traceId: 'preview', payload });
        if (frame !== null) tui.push(frame);
      };
      for (const index of [1, 2]) {
        send({ type: 'turn.started', turnId: 'turn-' + index, index, model: 'fixture', providerId: 'fixture', apiFormat: 'anthropic' });
        const thinking = 'Reasoning for step ' + index;
        send({ type: 'assistant.thinking_delta', messageId: 'm', index: 0, delta: thinking });
        const text = index === 1 ? 'STEP ONE: before the first tool.' : 'STEP TWO: after the first tool.';
        for (let i = 0; i < text.length; i += 3) {
          if (interrupted || closed) return 'cancelled';
          send({ type: 'assistant.text_delta', messageId: 'm', index: 0, delta: text.slice(i, i + 3) });
          await sleep(35);
        }
        send({ type: 'assistant.thinking_block', messageId: 'm', index: 0, thinking });
        send({ type: 'assistant.text_block', messageId: 'm', index: 0, text });
        send({ type: 'tool.call_started', toolCallId: 'c' + index, toolName: 'bash', arguments: { command: 'echo fixture-' + index }, attempt: 1 });
        send({ type: 'tool.progress', toolCallId: 'c' + index, elapsedMs: index * 1000 });
        if (index === 2) {
          const approved = new Promise<boolean>((resolve) => { answerPermission = resolve; });
          send({ type: 'permission.requested', requestId: 'fixture-approval', toolName: 'bash', toolInput: { command: 'echo fixture-2' }, mode: 'generic', kind: 'generic', startedAt: Date.now(), expiresAt: Date.now() + 300_000 });
          const allowed = await approved;
          answerPermission = null;
          if (interrupted || closed) { await sleep(250); return 'cancelled'; }
          send({ type: 'tool.call_completed', toolCallId: 'c2', content: allowed ? 'approved fixture' : 'denied fixture', durationMs: 1, outcome: { outcome: 'success' } });
          tui.printNotice(allowed ? 'Approval delivered to fixture.' : 'Denial delivered to fixture.');
        } else {
          send({ type: 'tool.call_completed', toolCallId: 'c1', content: 'fixture result', durationMs: 1, outcome: { outcome: 'success' } });
        }
      }
      send({ type: 'run.completed', status: 'completed' });
      return 'completed';
    }
    const answer = '先把消息流与输入分开管理。\n\n' +
      'Host 事件按 session、run 和 seq 进入消息状态；输入框始终保留焦点，运行中发送的内容进入待发队列。\n\n' +
      '完成消息校正流式增量，状态与待发预览留在输入框上方。打开选择器后，关闭它仍能继续输入。';
    for (let index = 0; index < answer.length && !closed; index += 2) {
      if (interrupted) return 'cancelled';
      tui.push({ type: 'text_delta', data: { content: answer.slice(index, index + 2) } });
      await sleep(65);
    }
    if (closed) return 'cancelled';
    tui.push({ type: 'text', data: { content: answer } });
    tui.push({ type: 'done' });
    return 'completed';
  },
  onChange: ({ busy }) => { if (!closed) { tui.setBusy(busy); tui.refresh(); } },
  onError: (error) => tui.printError(String(error)),
});

function stop(): void {
  closed = true;
  queue.close();
  answerPermission?.(false);
  tui.stop();
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 30);
}

const tui = new TUIApp({
  title: 'duya',
  inline: process.env['DUYA_TUI_INLINE'] !== '0',
  keyOverrides: {},
  echoSubmitted: false,
  statusText: () => 'duya · local preview',
  queuedPrompts: () => queue.snapshot.pending,
  queuedCount: () => queue.snapshot.pending.length,
  queuePaused: () => queue.snapshot.paused,
  isBusy: () => queue.snapshot.busy,
  canAnswerPermissions: () => true,
  onRecallQueued: () => queue.takeLast(),
  completionSources: {
    slash: () => [
      { label: '/picker', value: '/picker', description: 'Open a session selector', kind: 'slash_command' },
      { label: '/queue', value: '/queue', description: 'Resume pending follow-ups', kind: 'slash_command' },
      { label: '/exit', value: '/exit', description: 'Exit the preview', kind: 'slash_command' },
    ],
    context: () => [],
    files: () => [],
  },
  onSubmit: async (text) => {
    if (text === '/exit') stop();
    else if (text === '/queue') queue.resume();
    else if (text === '/picker') {
      const value = await tui.chooseFiltered('Resume session', [
        { label: 'TUI foundation · event stream', value: 'events' },
        { label: 'Composer · multiline input', value: 'composer' },
        { label: 'Terminal lifecycle · modal return', value: 'terminal' },
      ]);
      if (value !== null) tui.printNotice('Selected: ' + value);
    } else queue.submit(text);
  },
  onInterrupt: () => { interrupted = true; answerPermission?.(false); queue.pause(); },
  onExit: stop,
});
tui.onPermissionDecision = (_id, decision) => answerPermission?.(decision === 'once' || decision === 'always');

tui.start();
if (process.env['DUYA_TUI_SCENARIO'] === 'bugs') queue.submit('bugs');
else {
  queue.submit('先把 TUI 的事件流、消息流和输入框基础打好。');
  setTimeout(() => queue.submit('然后检查选择器关闭后，输入是否仍然正常。'), 700);
}
