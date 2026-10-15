/** Local terminal fixture. No Host, provider credentials, or model calls. */
import { TUIApp } from '../TUIApp.js';
import { TurnQueue } from '../turn-queue.js';

let interrupted = false;
let closed = false;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const queue = new TurnQueue({
  execute: async (prompt) => {
    interrupted = false;
    tui.printUser(prompt);
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
  onInterrupt: () => { interrupted = true; queue.pause(); },
  onExit: stop,
});

tui.start();
queue.submit('先把 TUI 的事件流、消息流和输入框基础打好。');
setTimeout(() => queue.submit('然后检查选择器关闭后，输入是否仍然正常。'), 700);
