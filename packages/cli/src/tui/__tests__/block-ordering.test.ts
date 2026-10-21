import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'stream';
import { TranscriptModel, resetBlockIds } from '../blocks.js';
import { DeltaBuffer } from '../delta-buffer.js';
import { TUIApp } from '../TUIApp.js';
import { detectTerminalEnvironment } from '../terminal-env.js';

/**
 * The ordering contract, stated as shapes so a regression names itself.
 *
 * A turn is `text / tool / text`. Before this was fixed, the model kept ONE
 * live assistant block for the whole turn, so the second text merged into the
 * block sitting ABOVE the tool line and the transcript read
 * `assistant("BEFORE-AFTER") / tool` — the tool appearing below text written
 * after it. There were two independent causes and both are covered here.
 */

/** The transcript reduced to something a reader would recognise as order. */
function shape(model: TranscriptModel): string[] {
  return model.blocks.map((block) => {
    switch (block.kind) {
      case 'assistant': return `text:${JSON.stringify(block.text)}`;
      case 'thinking': return `thinking:${JSON.stringify(block.text)}`;
      case 'tool': return `tool:${block.name}`;
      case 'user': return 'user';
      default: return block.kind;
    }
  });
}

describe('content blocks keep arrival order across a tool call', () => {
  it('creates new keyed blocks without needing a tool boundary', () => {
    const model = new TranscriptModel();
    for (const kind of ['text', 'thinking']) {
      model.apply({ type: kind + '_delta', data: { content: 'first', messageId: 'm', index: 0 } });
      model.apply({ type: kind + '_delta', data: { content: 'second', messageId: 'm', index: 1 } });
      expect(model.blocks.filter((b) => b.kind === (kind === 'text' ? 'assistant' : 'thinking'))
        .map((b) => 'text' in b ? b.text : '')).toEqual(['first', 'second']);
      model.apply({ type: kind, data: { content: 'first final', messageId: 'm', index: 0 } });
      model.apply({ type: kind, data: { content: 'second final', messageId: 'm', index: 1 } });
    }
    expect(shape(model)).toEqual(['text:"first final"', 'text:"second final"', 'thinking:"first final"', 'thinking:"second final"']);
  });
  it('puts text written after a tool call BELOW that tool line', () => {
    resetBlockIds();
    const model = new TranscriptModel();
    model.addUser('prompt');
    model.apply({ type: 'text_delta', data: { content: 'BEFORE-TOOL' } });
    model.apply({ type: 'tool_use_started', data: { id: 'c1', name: 'bash', input: { command: 'ls' } } });
    model.apply({ type: 'tool_result', data: { id: 'c1', result: 'ok' } });
    model.apply({ type: 'text_delta', data: { content: 'AFTER-TOOL' } });

    expect(shape(model)).toEqual([
      'user',
      'text:"BEFORE-TOOL"',
      'tool:bash',
      'text:"AFTER-TOOL"',
    ]);
  });

  it('routes each content block to the block its messageId+index names', () => {
    resetBlockIds();
    const model = new TranscriptModel();
    model.addUser('prompt');
    model.apply({ type: 'text_delta', data: { content: 'first', messageId: 'm1', index: 0 } });
    model.apply({ type: 'tool_use_started', data: { id: 'c1', name: 'bash', input: {} } });
    model.apply({ type: 'text_delta', data: { content: 'second', messageId: 'm1', index: 2 } });

    expect(shape(model)).toEqual(['user', 'text:"first"', 'tool:bash', 'text:"second"']);

    // The authoritative whole-block frames are republished AFTER the loop, in
    // content order and no longer adjacent to their deltas. Keying is what
    // makes them land on the right block instead of on "the last one".
    model.apply({ type: 'text', data: { content: 'first', messageId: 'm1', index: 0 } });
    model.apply({ type: 'text', data: { content: 'second', messageId: 'm1', index: 2 } });
    expect(shape(model)).toEqual(['user', 'text:"first"', 'tool:bash', 'text:"second"']);
  });

  it('does not split one tool call into two blocks across its preview and its call', () => {
    resetBlockIds();
    const model = new TranscriptModel();
    model.addUser('prompt');
    model.apply({ type: 'text_delta', data: { content: 'thinking about it', messageId: 'm1', index: 0 } });
    // `tool_use_started` announces; `tool_use` is the authoritative restatement
    // of the SAME call. Treating the second as a new call would chop the text
    // block in half for no reason.
    model.apply({ type: 'tool_use_started', data: { id: 'c1', name: 'bash', input: { command: 'ls' } } });
    model.apply({ type: 'tool_use', data: { id: 'c1', name: 'bash', input: { command: 'ls -la' } } });
    model.apply({ type: 'tool_result', data: { id: 'c1', result: 'ok' } });

    expect(shape(model)).toEqual(['user', 'text:"thinking about it"', 'tool:bash']);
  });

  it('closes thinking too, so a tool never lands between thought and text', () => {
    resetBlockIds();
    const model = new TranscriptModel();
    model.addUser('prompt');
    model.apply({ type: 'thinking_delta', data: { content: 'hmm', messageId: 'm1', index: 0 } });
    model.apply({ type: 'tool_use_started', data: { id: 'c1', name: 'bash', input: {} } });
    model.apply({ type: 'text_delta', data: { content: 'done', messageId: 'm1', index: 1 } });

    expect(shape(model)).toEqual(['user', 'thinking:"hmm"', 'tool:bash', 'text:"done"']);
  });
});

/**
 * The second cause: `drainBuffers` is throttled, so text buffered for an
 * earlier block could still be uncommitted when the tool frame arrived, and
 * then landed below it. `push` must commit before it appends anything.
 */
describe('buffered deltas are committed before any other frame is applied', () => {
  it('commits thinking before text even when neither buffer contains a newline', () => {
    const app = new TUIApp({ output: new Writable({ write: (_c, _e, cb) => cb() }), input: new PassThrough(), inline: false, onSubmit: () => {} });
    app.push({ type: 'thinking_delta', data: { content: 'first', messageId: 'm', index: 0 } });
    app.push({ type: 'text_delta', data: { content: 'second', messageId: 'm', index: 1 } });
    app.setBusy(false);
    expect(shape((app as unknown as { model: TranscriptModel }).model)).toEqual(['thinking:"first"', 'text:"second"']);
    app.stop();
  });
  it('never lets a tool line overtake text already written for the previous block', () => {
    resetBlockIds();
    const app = new TUIApp({
      output: new Writable({ write: (_c, _e, cb) => cb() }),
      input: new PassThrough(),
      inline: false,
      terminalEnv: detectTerminalEnvironment({ TERM_PROGRAM: 'WezTerm' }),
      onSubmit: () => {},
    });
    try {
      // No newline, and well inside the staleness window, so `take()` would
      // return nothing: this fragment is genuinely still buffered.
      app.push({ type: 'text_delta', data: { content: 'typed before the tool', messageId: 'm1', index: 0 } });
      app.push({ type: 'tool_use_started', data: { id: 'c1', name: 'bash', input: { command: 'ls' } } });
      app.push({ type: 'text_delta', data: { content: 'after the tool', messageId: 'm1', index: 1 } });
      // The turn boundary commits the tail, which is still buffered for the
      // same reason the first fragment was.
      app.setBusy(false);

      const blocks = (app as unknown as { model: TranscriptModel }).model;
      expect(shape(blocks)).toEqual([
        'text:"typed before the tool"',
        'tool:bash',
        'text:"after the tool"',
      ]);
    } finally {
      (app as unknown as { dispose?: () => void }).dispose?.();
    }
  });

  it('refuses to merge two content blocks in one buffer instead of guessing', () => {
    // The guard lives in `DeltaBuffer` because a merge is silent: the text
    // still renders, just in the wrong place. Throwing is what makes it loud.
    const buffer = new DeltaBuffer({ staleMs: 100_000 });
    buffer.append('a', 0, 'm#0');
    expect(() => buffer.append('b', 1, 'm#1')).toThrow(/commit the buffer before switching blocks/u);
  });
});
