/**
 * The todo list the transcript draws.
 *
 * The reference shapes are codex's `PlanUpdateCell` (`history_cell/plans.rs`)
 * and minimax-code's `kind:'todo'` cell (`transcript/view.ts`): a head that
 * carries the progress count, and one marker per item under it. This suite
 * pins the duya shape of both, plus the two things that are duya's own
 * decisions: the list reads out of the tool result (the tool is merge-
 * semantic, so the result IS the whole list), and two writes never batch.
 */

import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import { DEFAULT_RENDER_OPTIONS, renderTranscript } from '../transcript-view.js';
import { parseTodoItems } from '../todo.js';

/** Strip blessed tags, leaving the text a reader sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

/** The result shape `TodoTool` returns. */
function todoResult(items: ReadonlyArray<{ id: string; content: string; status: string }>): string {
  return JSON.stringify({
    summary_for_prompt: 'tracked',
    todos: items.map((item) => ({ id: item.id, content: item.content, status: item.status })),
  });
}

const THREE_ITEMS = [
  { id: 'a', content: 'Read the schema', status: 'completed' },
  { id: 'b', content: 'Implement the parser', status: 'in_progress' },
  { id: 'c', content: 'Write the tests', status: 'pending' },
];

/** One todo write, finished. */
function todoModel(items: ReadonlyArray<{ id: string; content: string; status: string }>): TranscriptModel {
  const model = new TranscriptModel();
  model.upsertTool('call-1', 'todo', { todos: items });
  model.completeTool('call-1', todoResult(items), false);
  return model;
}

describe('todo result parsing', () => {
  it('reads the list out of a todo result', () => {
    expect(parseTodoItems(todoResult(THREE_ITEMS))).toEqual([
      { id: 'a', content: 'Read the schema', status: 'completed' },
      { id: 'b', content: 'Implement the parser', status: 'in_progress' },
      { id: 'c', content: 'Write the tests', status: 'pending' },
    ]);
  });

  it('returns null for a result that is not a todo list', () => {
    expect(parseTodoItems('not json')).toBeNull();
    expect(parseTodoItems('{"success":true}')).toBeNull();
    expect(parseTodoItems('{"todos":"nope"}')).toBeNull();
  });

  it('reads an emptied list as an empty list, not as a failure', () => {
    expect(parseTodoItems(todoResult([]))).toEqual([]);
  });

  it('falls back to pending for a status it does not know', () => {
    expect(parseTodoItems(todoResult([{ id: 'a', content: 'x', status: 'weird' }])))
      .toEqual([{ id: 'a', content: 'x', status: 'pending' }]);
  });

  it('falls back to the id when the item carries no content', () => {
    expect(parseTodoItems(todoResult([{ id: 'a', content: '', status: 'pending' }])))
      .toEqual([{ id: 'a', content: 'a', status: 'pending' }]);
  });

  it('reads the list out of the envelope the executor wraps around the result', () => {
    // The fixture above hands a bare JSON document, which is what let this suite
    // stay green while the checklist never appeared on screen: the live wire
    // never carries one. `StreamingToolExecutor` wraps EVERY result in
    // `[completed] <tool>\n…\n[Duration: Nms]`, so the string that reaches the
    // transcript starts with `[completed] todo`, `JSON.parse` was never reached,
    // and the row rendered as the bare `Todo list` head.
    const wrapped = `[completed] todo\n${todoResult(THREE_ITEMS)}\n[Duration: 185ms]`;
    expect(parseTodoItems(wrapped)).toEqual(parseTodoItems(todoResult(THREE_ITEMS)));
    expect(parseTodoItems(`[failed] todo\n${todoResult(THREE_ITEMS)}\n[Duration: 12ms]`))
      .toHaveLength(3);
  });

  it('does not invent a list out of prose that merely mentions one', () => {
    // Unwrapping must not turn the parser into a substring search: a result
    // with no JSON body is still not a todo list.
    expect(parseTodoItems('[completed] todo\nNo tasks currently tracked.\n[Duration: 3ms]')).toBeNull();
  });
});

describe('todo rendering', () => {
  it('draws the head with the progress count and one marker per item', () => {
    const rendered = strip(renderTranscript(todoModel(THREE_ITEMS))).split('\n');
    expect(rendered).toEqual([
      '└ ✔ Todo list 1/3',
      '    ✔ Read the schema',
      '    ● Implement the parser',
      '    ○ Write the tests',
    ]);
  });

  it('draws the list from the payload the live wire actually carries', () => {
    // The render contract pinned above reads a tidied result. This reads the
    // enveloped one, because that is the string `tool.call_completed` puts on
    // the wire, and the gap between the two is why the checklist went missing.
    const model = new TranscriptModel();
    model.upsertTool('call-1', 'todo', { todos: THREE_ITEMS });
    model.completeTool('call-1', `[completed] todo\n${todoResult(THREE_ITEMS)}\n[Duration: 185ms]`, false);
    expect(strip(renderTranscript(model)).split('\n')).toEqual([
      '└ ✔ Todo list 1/3',
      '    ✔ Read the schema',
      '    ● Implement the parser',
      '    ○ Write the tests',
    ]);
  });

  it('draws the list even when tool results are hidden', () => {
    // The list IS the result of a todo write: a disclosure that hid it would
    // hide the only thing the reader came for.
    const rendered = strip(renderTranscript(todoModel(THREE_ITEMS), {
      ...DEFAULT_RENDER_OPTIONS,
      showToolResults: false,
    }));
    expect(rendered).toContain('Todo list 1/3');
    expect(rendered).toContain('Implement the parser');
  });

  it('never prints the raw JSON result', () => {
    const rendered = strip(renderTranscript(todoModel(THREE_ITEMS)));
    expect(rendered).not.toContain('summary_for_prompt');
    expect(rendered).not.toContain('"todos"');
    expect(rendered).not.toContain('todo(');
  });

  it('shows a running write as a bare head', () => {
    const model = new TranscriptModel();
    model.upsertTool('call-1', 'todo', { todos: THREE_ITEMS });
    const rendered = strip(renderTranscript(model)).split('\n');
    expect(rendered).toEqual(['└ ⏺ Todo list']);
  });

  it('keeps two writes apart instead of batching them', () => {
    // The second write is the state AFTER the first, so batching them behind
    // one `todo 2 calls` header would hide the second list.
    const model = new TranscriptModel();
    model.upsertTool('call-1', 'todo', { todos: THREE_ITEMS });
    model.completeTool('call-1', todoResult(THREE_ITEMS), false);
    model.upsertTool('call-2', 'todo', { todos: THREE_ITEMS });
    model.completeTool('call-2', todoResult(THREE_ITEMS), false);
    const rendered = strip(renderTranscript(model)).split('\n');
    expect(rendered.filter((row) => row.includes('Todo list'))).toHaveLength(2);
    expect(rendered.join('\n')).not.toContain('todo 2 calls');
  });

  it('re-renders when a list changes status', () => {
    // The transcript cache keys a block on its content: a list whose items
    // changed must not keep rendering the version the reader first saw.
    const model = todoModel(THREE_ITEMS);
    const before = strip(renderTranscript(model));
    const block = model.toolByCallId('call-1');
    (block as { todos?: unknown }).todos = [
      { id: 'a', content: 'Read the schema', status: 'completed' },
      { id: 'b', content: 'Implement the parser', status: 'completed' },
      { id: 'c', content: 'Write the tests', status: 'completed' },
    ];
    const after = strip(renderTranscript(model));
    expect(before).toContain('Todo list 1/3');
    expect(after).toContain('Todo list 3/3');
  });

  it('folds a long item to the pane width', () => {
    const long = 'x'.repeat(200);
    const rendered = strip(renderTranscript(todoModel([
      { id: 'a', content: long, status: 'pending' },
    ]), { ...DEFAULT_RENDER_OPTIONS, width: 40 })).split('\n');
    expect(rendered.length).toBeGreaterThan(2);
    for (const row of rendered.slice(1)) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
  });
});
