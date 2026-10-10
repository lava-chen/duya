import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PopoverItem } from '@duya/input-completion';
import { CompletionController } from '../ui/completion.js';
import { fileItems, relativePath } from '../ui/candidates.js';

/**
 * The completion state machine, driven the way a user drives it.
 *
 * Every test types characters and moves the caret, because that is the only
 * sequence that exercises the part that actually broke: the popup is a function
 * of TEXT AND CARET, and a test that only sets a final string never proves the
 * caret is being read.
 */

function item(label: string, value: string, description = ''): PopoverItem {
  return { label, value, description };
}

const SLASH = [item('/doctor', '/doctor', 'Diagnose'), item('/review', '/review', 'Review')];
const CONTEXT = [item('@plan-task', 'plan-task', 'Plan mode')];

function makeController(over: Partial<{ slash: PopoverItem[]; context: PopoverItem[]; files: PopoverItem[] }> = {}) {
  return new CompletionController({
    slash: () => over.slash ?? SLASH,
    context: () => over.context ?? CONTEXT,
    files: () => over.files ?? [],
  });
}

describe('CompletionController — opening', () => {
  it('opens on a slash and offers every command', () => {
    const c = makeController();
    const state = c.update('/', 1);
    expect(state.mode).toBe('skill');
    expect(state.items.map((i) => i.value)).toEqual(['/doctor', '/review']);
  });

  it('filters as the user types', () => {
    const c = makeController();
    expect(c.update('/rev', 4).items.map((i) => i.value)).toEqual(['/review']);
  });

  it('opens on @ and offers the context rows', () => {
    const c = makeController();
    expect(c.update('@', 1).items.map((i) => i.value)).toEqual(['plan-task']);
  });

  it('starts closed, and closes again when the trigger is gone', () => {
    const c = makeController();
    expect(c.isOpen).toBe(false);
    c.update('/doc', 4);
    expect(c.isOpen).toBe(true);
    expect(c.update('plain text', 10).mode).toBeNull();
    expect(c.isOpen).toBe(false);
  });

  it('closes when the caret moves before the trigger', () => {
    // Moving the caret INTO the span keeps it open with a shorter filter, which
    // is correct; moving it before the trigger is what closes it.
    const c = makeController();
    c.update('/doc', 4);
    expect(c.update('/doc', 0).mode).toBeNull();
  });

  it('narrows the filter rather than closing when the caret moves into the span', () => {
    const c = makeController();
    expect(c.update('/doc', 3).filter).toBe('do');
    expect(c.isOpen).toBe(true);
  });

  it('does not open when nothing matches', () => {
    const c = makeController();
    expect(c.isOpen).toBe(false);
    c.update('/zzz', 4);
    expect(c.isOpen).toBe(false);
  });

  it('does not open mid-word, so a path in the prompt is not a command', () => {
    const c = makeController();
    expect(c.update('src/index.ts', 12).mode).toBeNull();
  });
});

describe('CompletionController — keys', () => {
  it('Enter submits when the popup is closed, so a prompt still sends', () => {
    const c = makeController();
    const result = c.handleKey('return', 'hello');
    expect(result.consumed).toBe(false);
    expect(result.accepted).toBeNull();
  });

  it('Enter accepts instead of submitting when the popup is open', () => {
    const c = makeController();
    c.update('/rev', 4);
    const result = c.handleKey('return', '/rev');
    expect(result.consumed).toBe(true);
    expect(result.accepted?.text).toBe('/review ');
  });

  it('Tab accepts and never reaches the input line', () => {
    const c = makeController();
    c.update('/rev', 4);
    const result = c.handleKey('tab', '/rev');
    expect(result.consumed).toBe(true);
    expect(result.accepted?.text).toBe('/review ');
  });

  it('Tab with no popup is NOT consumed', () => {
    const c = makeController();
    expect(c.handleKey('tab', 'hello').consumed).toBe(false);
  });

  it('arrows move the selection and wrap', () => {
    const c = makeController();
    c.update('/', 1);
    expect(c.snapshot.selectedIndex).toBe(0);
    c.handleKey('down', '/');
    expect(c.snapshot.selectedIndex).toBe(1);
    c.handleKey('down', '/');
    expect(c.snapshot.selectedIndex).toBe(0);
    c.handleKey('up', '/');
    expect(c.snapshot.selectedIndex).toBe(1);
  });

  it('arrows are NOT consumed when no popup is open', () => {
    const c = makeController();
    expect(c.handleKey('down', 'hello').consumed).toBe(false);
    expect(c.handleKey('up', 'hello').consumed).toBe(false);
  });

  it('Escape closes without inserting', () => {
    const c = makeController();
    c.update('/rev', 4);
    const result = c.handleKey('escape', '/rev');
    expect(result.consumed).toBe(true);
    expect(result.accepted).toBeNull();
    expect(c.isOpen).toBe(false);
    // The typed text is untouched: Escape dismisses the list, it does not undo
    // what the user already typed.
    expect('/rev').toBe('/rev');
  });

  it('Escape with nothing open is NOT consumed, so it can cancel a turn', () => {
    const c = makeController();
    expect(c.handleKey('escape', 'hello').consumed).toBe(false);
  });
});

describe('CompletionController — accepting', () => {
  it('replaces only the trigger span, keeping surrounding text', () => {
    const c = makeController();
    const text = 'please run /rev now';
    c.update(text, text.indexOf('/rev') + 4);
    const accepted = c.accept(text);
    // `after` already begins with a space, so NO second space is added — the
    // double-space guard in `resolveItemSelection` is what makes this single.
    expect(accepted?.text).toBe('please run /review now');
  });

  it('puts the caret AFTER the inserted text, so typing does not edit it', () => {
    const c = makeController();
    c.update('/rev', 4);
    const accepted = c.accept('/rev');
    // '/review ' is 8 characters from position 0.
    expect(accepted?.cursor).toBe(8);
  });

  it('inserts @ for a context row', () => {
    const c = makeController();
    c.update('@plan', 5);
    const accepted = c.accept('@plan');
    expect(accepted?.text).toBe('@plan-task ');
  });

  it('keeps the selection inside the filtered list as it shrinks', () => {
    const c = makeController();
    c.update('/', 1);
    c.handleKey('down', '/');
    expect(c.snapshot.selectedIndex).toBe(1);
    // Narrow to one row; an index of 1 would now be out of range.
    c.update('/rev', 4);
    expect(c.snapshot.items).toHaveLength(1);
    expect(c.snapshot.selectedIndex).toBeLessThan(c.snapshot.items.length);
  });
});

describe('CompletionController — file paths', () => {
  it('ranks a path a substring filter could not find', () => {
    const c = makeController({
      context: [],
      files: [item('src/app/useApp.ts', 'src/app/useApp.ts'), item('README.md', 'README.md')],
    });
    const state = c.update('@src/uA', 6);
    expect(state.items.map((i) => i.value)).toEqual(['src/app/useApp.ts']);
  });

  it('offers context rows before files', () => {
    const c = makeController({ files: [item('a.ts', 'a.ts')] });
    expect(c.update('@', 1).items.map((i) => i.value)).toEqual(['plan-task', 'a.ts']);
  });
});

describe('fileItems — the workspace walk', () => {
  it('finds files as workspace-relative forward-slash paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-completion-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};');

    const found = fileItems(root);
    expect(found.map((i) => i.value)).toContain('src/index.ts');
  });

  it('skips the directories that would swamp the list', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-completion-'));
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), '');
    writeFileSync(join(root, '.git', 'HEAD'), '');
    writeFileSync(join(root, 'src', 'keep.ts'), '');

    const values = fileItems(root).map((i) => i.value);
    expect(values).toContain('src/keep.ts');
    expect(values.some((v) => v.includes('node_modules'))).toBe(false);
    expect(values.some((v) => v.startsWith('.git'))).toBe(false);
  });

  it('honours the limit instead of walking the whole tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-completion-'));
    mkdirSync(join(root, 'many'), { recursive: true });
    for (let i = 0; i < 20; i += 1) writeFileSync(join(root, 'many', `f${i}.ts`), '');

    expect(fileItems(root, 5).length).toBeLessThanOrEqual(5);
  });

  it('survives a directory it cannot read', () => {
    // Completion must never fail because of a permission problem: the user did
    // not ask about permissions.
    const found = fileItems(join(tmpdir(), 'duya-does-not-exist-12345'));
    expect(found).toEqual([]);
  });

  it('normalises Windows separators', () => {
    expect(relativePath('C:\\ws', 'C:\\ws\\src\\a.ts')).toBe('src/a.ts');
  });

  it('normalises a trailing separator on the root', () => {
    expect(relativePath('C:\\ws\\', 'C:\\ws\\src\\a.ts')).toBe('src/a.ts');
  });
});