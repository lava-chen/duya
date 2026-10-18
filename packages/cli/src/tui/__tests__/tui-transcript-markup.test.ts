import { describe, it, expect } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import { renderTranscript, renderOneBlock, escapeTags } from '../transcript-view.js';

/**
 * Rendered markup must not survive into the text.
 *
 * ## The defect this pins down
 *
 * Bright tags use Blessed's hyphenated names, and each payload gets one flat
 * style. Camel-case names such as `brightGreen-fg` are emitted literally by
 * Blessed even though they look valid as a UI component or CSS token.
 *
 * ## What these tests can and cannot prove
 *
 * These assertions pin the markup emitted by this pure renderer. The
 * TUIApp integration suite separately feeds it through Blessed's real parser.
 */

const OPTIONS = { expanded: false, showToolResults: true, toolResultLines: 5 };

/** Drop blessed tags so layout assertions read the text a user sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

function render(): string {
  const model = new TranscriptModel();
  model.addUser('你是谁');
  model.addNotice('45 tools available');
  return renderTranscript(model, OPTIONS);
}

describe('transcript-view markup', () => {
  it('uses Blessed-compatible bright color tag names', () => {
    expect(render()).toContain('{bright-green-fg}› 你是谁{/bright-green-fg}');
    expect(render()).not.toContain('brightGreen-fg');
  });

  it('leaves no closing tag for any style it opens', () => {
    const rendered = render();
    const opened = new Set<string>();
    for (const match of rendered.matchAll(/\{([a-zA-Z-]+)\}/g)) {
      const name = match[1] as string;
      if (name.startsWith('/')) continue;
      opened.add(name);
    }
    for (const name of opened) {
      expect(rendered, `style ${name} is opened but never closed`).toContain(`{/${name}}`);
    }
  });

  it('still prints the user text itself', () => {
    expect(render()).toContain('你是谁');
  });

  it('brackets the user line in exactly one balanced style', () => {
    const rendered = render();
    // Flat by design: the nested form leaked its outer closing tag.
    expect(rendered).toContain('{bright-green-fg}› 你是谁{/bright-green-fg}');
  });

  it('escapes braces in model output rather than letting blessed eat them', () => {
    const model = new TranscriptModel();
    model.appendTextDelta('const x = { a: 1 };');
    const rendered = renderTranscript(model, OPTIONS);
    // `{ a: 1 }` would otherwise be read as a tag. `{open}` is blessed's own
    // literal-brace escape; the old `\{` was never parsed as an escape at all.
    expect(rendered).toContain('{open}');
    expect(rendered).toContain('a: 1');
  });

  it('escapes braces in a NOTICE too, which the leak-prone arm used to skip', () => {
    const model = new TranscriptModel();
    model.addNotice('payload {bright-green-fg}green{/bright-green-fg}');
    const rendered = renderTranscript(model, OPTIONS);
    // Exactly one unescaped opener would be the payload; the real style's
    // opener plus an escaped copy is what a correct render looks like.
    expect(rendered).toContain('{open}bright-green-fg}');
  });

  it('renders common Markdown structure while preserving CJK and identifier text', () => {
    const rendered = renderOneBlock({
      kind: 'assistant',
      id: 'assistant-1',
      finalized: true,
      text: '# 结果\n\n- **完成**\n- `snake_case`\n\n> 你好，*世界*',
    });

    expect(rendered).toContain('{cyan-fg}# {/cyan-fg}结果');
    expect(rendered).toContain('{bold}完成{/bold}');
    expect(rendered).toContain('{gray-fg}snake_case{/gray-fg}');
    expect(rendered).toContain('{gray-fg}│{/gray-fg} 你好，{cyan-fg}世界{/cyan-fg}');
  });

  it('renders task-list checkboxes with distinct checked and pending states', () => {
    const rendered = renderOneBlock({
      kind: 'assistant',
      id: 'assistant-tasks',
      finalized: true,
      text: '- [x] 已完成\n- [ ] 待处理',
    });

    expect(rendered).toContain('{bright-green-fg}☑{/bright-green-fg} 已完成');
    expect(rendered).toContain('{gray-fg}☐{/gray-fg} 待处理');
  });

  it('renders fenced code as a labeled, escaped block', () => {
    const rendered = renderOneBlock({
      kind: 'assistant',
      id: 'assistant-2',
      finalized: true,
      text: '```ts\nconst payload = { ok: true };\n```',
    });

    expect(rendered).toContain('{gray-fg}  ┌─ ts · 1 line ─{/gray-fg}');
    expect(rendered).toContain('{gray-fg}  │ 1 │{/gray-fg}');
    expect(rendered).toContain('const payload = {open} ok: true };');
    expect(rendered).toContain('{gray-fg}  └─{/gray-fg}');
  });

  it('colors unified diff headers, hunks, additions, and removals', () => {
    const rendered = renderOneBlock({
      kind: 'assistant',
      id: 'assistant-diff',
      finalized: true,
      text: '```diff\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n```',
    });

    expect(rendered).toContain('{cyan-fg}@@ -1 +1 @@{/cyan-fg}');
    expect(rendered).toContain('{red-fg}-old{/red-fg}');
    expect(rendered).toContain('{bright-green-fg}+new{/bright-green-fg}');
  });

  it('recognizes a diff in a tool result and keeps its line colors', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'diff-call', name: 'terminal', input: { command: 'git diff' } } });
    model.apply({
      type: 'tool_result',
      data: { id: 'diff-call', result: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new' },
    });

    const rendered = renderTranscript(model, OPTIONS);
    expect(rendered).toContain('{red-fg}-old{/red-fg}');
    expect(rendered).toContain('{bright-green-fg}+new{/bright-green-fg}');
  });

  it('keeps an unfinished streaming fence readable and closes only its display frame', () => {
    const rendered = renderOneBlock({
      kind: 'assistant',
      id: 'assistant-3',
      finalized: false,
      text: '```json\n{"ready": false}',
    });

    expect(rendered).toContain('{open}"ready": false}');
    expect(rendered.endsWith('{gray-fg}  └─{/gray-fg}')).toBe(true);
  });

  it('withholds a still-growing streaming table so its borders stop moving', () => {
    const table = 'intro\n\n| name | value |\n|------|-------|\n| a | 1 |';

    const streaming = renderOneBlock({ kind: 'assistant', id: 's', finalized: false, text: table });
    // The prose above the table is committed; the table itself is withheld.
    expect(streaming).toContain('intro');
    expect(streaming).not.toContain('value');

    const finished = renderOneBlock({ kind: 'assistant', id: 'f', finalized: true, text: `${table}\n\ndone` });
    expect(finished).toContain('value');
    expect(finished).toContain('done');
  });

  it('releases a streaming table once a following line proves it finished', () => {
    const rendered = renderOneBlock({
      kind: 'assistant',
      id: 'released',
      finalized: false,
      text: '| name | value |\n|------|-------|\n| a | 1 |\n\nafter the table',
    });
    expect(rendered).toContain('value');
    expect(rendered).toContain('after the table');
  });
});

describe('tool groups', () => {
  function groupModel(): TranscriptModel {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'c1', name: 'read_file', input: { path: 'a.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 'c1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 'c2', name: 'read_file', input: { path: 'b.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 'c2', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 'c3', name: 'read_file', input: { path: 'c.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 'c3', result: 'ok' } });
    return model;
  }

  it('summarises a batch under one header and lists every call as an equal child', () => {
    const rendered = strip(renderTranscript(groupModel(), OPTIONS));
    // One header carries the verb and the count; every call below it is an
    // equal child row showing only its target.
    expect(rendered).toContain('Read 3 files');
    expect(rendered).toContain('├ a.ts');
    expect(rendered).toContain('└ c.ts');
    // The tool name appears nowhere per call: repeating it was what made a
    // batch read as unrelated rows.
    expect(rendered).not.toContain('read_file(');
  });

  it('adds exactly one header row per batch to the ungrouped line count', () => {
    // `revealSelectedBlock` sums per-block heights from the same plan, so the
    // remaining invariant is that a batch costs exactly one extra row — its
    // summary — and no separator rows.
    const grouped = renderTranscript(groupModel(), OPTIONS).split('\n').length;
    const ungrouped = groupModel().blocks
      .map((block) => renderOneBlock(block, OPTIONS).split('\n').length)
      .reduce((total, lines) => total + lines, 0);
    expect(grouped).toBe(ungrouped + 1);
  });

  it('breaks the group when a different family intervenes', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'c1', name: 'read_file', input: { path: 'a.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 'c1', result: 'ok' } });
    // `terminal` is its own family (shell), so it breaks the exploration group
    // the two reads would otherwise share.
    model.apply({ type: 'tool_use', data: { id: 'c2', name: 'terminal', input: { command: 'ls' } } });
    model.apply({ type: 'tool_result', data: { id: 'c2', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 'c3', name: 'read_file', input: { path: 'c.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 'c3', result: 'ok' } });

    const rendered = renderTranscript(model, OPTIONS);
    expect(rendered.match(/read_file\(/gu)).toHaveLength(2);
    expect(rendered).toContain('terminal(');
  });

  it('summarises a mixed exploration pass as operations, not as one of its tools', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'e1', name: 'glob', input: { pattern: '**/*.ts' } } });
    model.apply({ type: 'tool_result', data: { id: 'e1', result: 'ok' } });
    model.apply({ type: 'tool_use', data: { id: 'e2', name: 'search_files', input: { pattern: 'x' } } });
    model.apply({ type: 'tool_result', data: { id: 'e2', result: 'ok' } });

    const rendered = strip(renderTranscript(model, OPTIONS));
    // `Listed 2 paths` would hide the search and `Searched 2 patterns` would
    // hide the listing, so a mixed pass is `Explored`.
    expect(rendered).toContain('Explored 2 operations');
    expect(rendered).toContain('├ **/*.ts');
    expect(rendered).toContain('└ x');
  });
});

describe('themes', () => {
  it('exposes a light palette that swaps gray for a readable 256-colour value', () => {
    const model = new TranscriptModel();
    model.addNotice('plain');
    const rendered = renderTranscript(model, { ...OPTIONS, theme: {
      muted: '243-fg', accent: '30-fg', success: '28-fg', error: '160-fg', warning: '172-fg',
      user: '28-fg', thinking: '128-fg', diffAdd: '28-fg', diffDel: '160-fg', heading: '30-fg', link: '243-fg',
    } });
    expect(rendered).toContain('{243-fg}plain{/243-fg}');
    expect(rendered).not.toContain('{gray-fg}plain');
  });
});

describe('escapeTags', () => {
  it('escapes every brace, not just the first', () => {
    expect(escapeTags('{a}{b}')).toBe('{open}a}{open}b}');
  });

  it('leaves text without braces alone', () => {
    expect(escapeTags('plain text')).toBe('plain text');
  });
});
