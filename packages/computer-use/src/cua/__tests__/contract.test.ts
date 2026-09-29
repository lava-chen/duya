/**
 * Contract tests for the CUA layer (plan 575 Phase 1 gate).
 *
 * Each test pins an alignment behavior against the ZCode/Codex contract:
 * kind mapping, key normalization, tree normalization, diff/mode
 * decision, token ledger lifecycle, and the observation text renderer.
 */

import { describe, expect, it } from 'vitest';

import { CONTROL_TYPE_TO_KIND, uiaControlTypeToKind } from '../kindMap.js';
import { normalizeKeyChord, splitChord } from '../keys.js';
import { adaptEnumerated, normalizeAxTree, type CuaTreeNode } from '../normalize.js';
import {
  CuaSnapshotCache,
  decideSnapshotMode,
  diffSnapshots,
} from '../diff.js';
import { CuaTokenLedger } from '../tokens.js';
import { elementPriority, elementRow, formatDiff, formatObservation } from '../format.js';
import { CuaError } from '../types.js';
import type { CuaElement, CuaObservation } from '../types.js';

describe('kindMap', () => {
  it('collapses buttons, menus, rows and containers exactly like the ZCode table', () => {
    expect(CONTROL_TYPE_TO_KIND.SplitButton).toBe('button');
    expect(CONTROL_TYPE_TO_KIND.MenuBar).toBe('menuitem');
    expect(CONTROL_TYPE_TO_KIND.TreeItem).toBe('row');
    expect(CONTROL_TYPE_TO_KIND.Pane).toBe('');
    expect(CONTROL_TYPE_TO_KIND.Custom).toBe('');
  });

  it('maps probe ControlType names and degrades unknown kinds to ""', () => {
    expect(uiaControlTypeToKind('Edit')).toBe('textfield');
    expect(uiaControlTypeToKind('Document')).toBe('textarea');
    expect(uiaControlTypeToKind('TabItem')).toBe('tab');
    expect(uiaControlTypeToKind('NotARealType')).toBe('');
    expect(uiaControlTypeToKind(null)).toBe('');
  });
});

describe('keys', () => {
  it('normalizes X keysym aliases to duya tokens', () => {
    expect(normalizeKeyChord('Control_L+a', 'win32')).toBe('ctrl+a');
    expect(normalizeKeyChord('Return', 'win32')).toBe('return');
    expect(normalizeKeyChord('escape', 'win32')).toBe('esc');
    expect(normalizeKeyChord('prior', 'win32')).toBe('pageup');
  });

  it('resolves super per platform', () => {
    expect(normalizeKeyChord('super+c', 'win32')).toBe('win+c');
    expect(normalizeKeyChord('super+c', 'darwin')).toBe('cmd+c');
    expect(normalizeKeyChord('super+c', 'linux')).toBe('super+c');
  });

  it('splits a normalized chord into modifiers + key', () => {
    expect(splitChord('ctrl+shift+a')).toEqual({ modifiers: ['ctrl', 'shift'], key: 'a' });
    expect(splitChord('return')).toEqual({ modifiers: [], key: 'return' });
  });
});

describe('normalize (tree pipeline)', () => {
  it('prunes non-descriptive non-interactive nodes', () => {
    const tree: CuaTreeNode[] = [
      { role: 'Group', title: null },
      { role: 'Button', title: 'OK', actions: ['AXPress'] },
    ];
    const out = normalizeAxTree(tree);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('Button');
  });

  it('keeps a container that only wraps interactive descendants', () => {
    const tree: CuaTreeNode[] = [
      {
        role: 'Group',
        children: [{ role: 'Button', title: 'Save', actions: ['AXPress'] }],
      },
    ];
    expect(normalizeAxTree(tree)).toHaveLength(1);
  });

  it('merges runs of text-only siblings and flattens anonymous single-child chains', () => {
    const tree: CuaTreeNode[] = [
      {
        role: 'Group',
        children: [
          {
            role: 'Group',
            children: [
              { role: 'Text', title: 'Hello' },
              { role: 'Text', title: 'World' },
            ],
          },
        ],
      },
    ];
    const out = normalizeAxTree(tree);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Hello World');
  });
});

describe('adaptEnumerated (flat probe path)', () => {
  it('derives kind, actions, pressable and masks password values', () => {
    const el = adaptEnumerated(
      { name: 'Sign in', controlType: 'Button', rect: { x: 10.4, y: 20.6, w: 80, h: 24 } },
      3,
      197144,
      48412,
    );
    expect(el.kind).toBe('button');
    expect(el.actions).toEqual(['AXPress']);
    expect(el.pressable).toBe(true);
    expect(el.bounds).toEqual([10, 21, 80, 24]);
    expect(el.probeIndex).toBe(3);
    expect(el.hwnd).toBe(197144);

    const pw = adaptEnumerated(
      { name: 'pw', controlType: 'Edit', isPassword: true, value: 'hunter2' },
      4,
      197144,
      48412,
    );
    expect(pw.value).toBeNull();
    expect(pw.editable).toBe(true);
    expect(pw.kind).toBe('textfield');
  });

  it('carries real UIA state bits through (plan 575 probe upgrade)', () => {
    const real = adaptEnumerated(
      { name: 'R', controlType: 'RadioButton', rect: null, enabled: false, focused: true, selected: true },
      1,
      100,
      11,
    );
    expect(real.enabled).toBe(false);
    expect(real.focused).toBe(true);
    expect(real.selected).toBe(true);

    // Older probe binaries omit the keys — the previous constants remain
    // the fallback.
    const legacy = adaptEnumerated(
      { name: 'B', controlType: 'Button', rect: null },
      2,
      100,
      11,
    );
    expect(legacy.enabled).toBe(true);
    expect(legacy.focused).toBe(false);
    expect(legacy.selected).toBe(false);
  });

  it('passes the plan 576 tree-contract fields through when reported', () => {
    const rich = adaptEnumerated(
      {
        name: null,
        controlType: 'Edit',
        rect: { x: 0, y: 0, w: 100, h: 24 },
        label: '用户名',
        depth: 4,
        checked: false,
        description: 'Account name',
        offscreen: true,
      },
      5,
      100,
      11,
    );
    expect(rich.label).toBe('用户名');
    expect(rich.depth).toBe(4);
    expect(rich.checked).toBe(false);
    expect(rich.description).toBe('Account name');
    expect(rich.offscreen).toBe(true);

    // Absent on the wire → absent on the element (no false constants).
    const bare = adaptEnumerated({ name: 'X', controlType: 'Edit', rect: null }, 6, 100, 11);
    expect(bare.label).toBeUndefined();
    expect(bare.depth).toBeUndefined();
    expect(bare.checked).toBeUndefined();
    expect(bare.offscreen).toBeUndefined();
  });

  it('derives spinner/split-button actions (plan 576 vocabulary)', () => {
    expect(adaptEnumerated({ controlType: 'Spinner' }, 1, 1, 1).actions).toEqual([
      'AXIncrement',
      'AXDecrement',
    ]);
    expect(adaptEnumerated({ controlType: 'SplitButton' }, 2, 1, 1).kind).toBe('button');
    expect(adaptEnumerated({ controlType: 'TreeItem' }, 3, 1, 1).kind).toBe('row');
  });
});

function makeEl(overrides: Partial<CuaElement>): CuaElement {
  return {
    native: 'cua-1',
    role: 'Button',
    kind: 'button',
    title: 'OK',
    value: null,
    bounds: [0, 0, 10, 10],
    enabled: true,
    focused: false,
    editable: false,
    actions: ['AXPress'],
    pressable: true,
    hasMenu: false,
    ownerPid: 1,
    probeIndex: 1,
    hwnd: 100,
    ...overrides,
  };
}

describe('diff', () => {
  it('first observation reports everything as added', () => {
    const diff = diffSnapshots(null, '', [makeEl({}), makeEl({ title: 'Cancel' })], 'W');
    expect(diff.addedCount).toBe(2);
    expect(diff.updatedCount).toBe(0);
    expect(diff.focusChanged).toBe(false);
  });

  it('detects material field changes and additions by stable id', () => {
    const old = [makeEl({ value: null }), makeEl({ title: 'Cancel', native: 'cua-2', probeIndex: 2 })];
    const next = [
      makeEl({ value: 'typed', focused: true }),
      makeEl({ title: 'Cancel', native: 'cua-2', probeIndex: 2 }),
      makeEl({ title: 'New', native: 'cua-3', probeIndex: 3 }),
    ];
    const diff = diffSnapshots(old, 'W', next, 'W');
    expect(diff.addedCount).toBe(1);
    expect(diff.updatedCount).toBe(1);
    expect(diff.updated[0].changes.value).toBe('typed');
    expect(diff.updated[0].changes.focused).toBe(true);
    expect(diff.focusChanged).toBe(true);
    expect(diff.focusedTitle).toBe('OK');
  });

  it('downgrades to no_change when nothing material moved', () => {
    const els = [makeEl({})];
    const diff = diffSnapshots(els, 'W', els.map((e) => ({ ...e })), 'W');
    const mode = decideSnapshotMode(diff, {
      previousWindowTitle: 'W',
      newWindowTitle: 'W',
      previousWindowId: 1,
      newWindowId: 1,
      previousWindowBounds: [0, 0, 100, 100],
      newWindowBounds: [0, 0, 100, 100],
      totalElements: els.length,
    });
    expect(mode).toBe('no_change');
  });

  it('forces full on window identity change or ratio blow-up', () => {
    const diff = diffSnapshots(null, '', Array.from({ length: 10 }, (_, i) => makeEl({ title: `b${i}`, probeIndex: i + 1 })), 'W');
    const base = {
      previousWindowTitle: 'W',
      newWindowTitle: 'W',
      previousWindowId: 1,
      newWindowId: 1,
      totalElements: 10,
    };
    expect(decideSnapshotMode(diff, base)).toBe('full'); // first observation: all added → ratio 1.0
    expect(
      decideSnapshotMode(diff, { ...base, newWindowTitle: 'Other' }),
    ).toBe('full');
    expect(
      decideSnapshotMode(diff, { ...base, newWindowId: 2 }),
    ).toBe('full');
  });

  it('caches per pid+window and invalidates', () => {
    const cache = new CuaSnapshotCache();
    const els = [makeEl({})];
    cache.set(1, 10, [0, 0, 1, 1], 'W', { elements: els, stateId: 's-1' });
    expect(cache.get(1, 10, [0, 0, 1, 1], 'W')?.stateId).toBe('s-1');
    expect(cache.get(2, 10, [0, 0, 1, 1], 'W')).toBeUndefined();
    cache.invalidate(1);
    expect(cache.get(1, 10, [0, 0, 1, 1], 'W')).toBeUndefined();
  });
});

describe('tokens', () => {
  it('issues window-scoped indices and bumps epochs on re-observation', () => {
    const ledger = new CuaTokenLedger();
    const epoch1 = ledger.issueSnapshot(100, 2, 5);
    expect(ledger.resolve(100, 1)).toMatchObject({ hwnd: 100, probeIndex: 1, pid: 5, epoch: epoch1 });
    const epoch2 = ledger.issueSnapshot(100, 2, 5);
    expect(epoch2).toBe(epoch1 + 1);
    expect(ledger.resolve(100, 2)?.epoch).toBe(epoch2);
    expect(ledger.currentEpoch(100)).toBe(epoch2);
    expect(ledger.isObserved(100)).toBe(true);
    expect(ledger.isObserved(200)).toBe(false);
  });

  it('fails closed for unknown slots and honors retire', () => {
    const ledger = new CuaTokenLedger();
    ledger.issueSnapshot(100, 1, 5);
    expect(ledger.resolve(100, 2)).toBeNull();
    expect(ledger.resolve(300, 1)).toBeNull();
    ledger.retire(100, 1);
    expect(ledger.resolve(100, 1)).toBeNull();
  });

  it('re-observation replaces slots wholesale (old indices fail closed)', () => {
    const ledger = new CuaTokenLedger();
    ledger.issueSnapshot(100, 3, 5);
    expect(ledger.resolve(100, 3)).not.toBeNull();
    ledger.issueSnapshot(100, 1, 5);
    // The fresh tree only emitted one element: index 3 is gone.
    expect(ledger.resolve(100, 3)).toBeNull();
    expect(ledger.resolve(100, 1)?.epoch).toBe(2);
    ledger.clear();
    expect(ledger.resolve(100, 1)).toBeNull();
    expect(ledger.currentEpoch(100)).toBe(0);
  });
});

describe('format', () => {
  it('scores pressable editable controls above containers and zero-area elements low', () => {
    const box: [number, number, number, number] = [0, 0, 1000, 800];
    const button = elementPriority(makeEl({ kind: 'button', title: 'OK' }), box);
    const pane = elementPriority(makeEl({ kind: '', role: 'Pane', title: null, actions: [] }), box);
    const zeroArea = elementPriority(makeEl({ bounds: [0, 0, 0, 0] }), box);
    const fullWindow = elementPriority(makeEl({ bounds: [0, 0, 1000, 800] }), box);
    expect(button).toBeGreaterThan(pane);
    expect(zeroArea).toBeLessThan(button);
    expect(fullWindow).toBeLessThan(button);
  });

  it('renders the aligned row shape', () => {
    const row = elementRow(
      16,
      makeEl({ title: '合并两个新的 Pull Request', actions: ['AXPress', 'AXScrollIntoView'] }),
    );
    expect(row).toBe(
      ' [16] button 合并两个新的 Pull Request (pressable) actions=[AXPress,AXScrollIntoView]',
    );
  });

  it('indents rows by the probe tree depth (plan 576)', () => {
    const row = elementRow(0, makeEl({ depth: 3, title: 'Deep' }));
    expect(row.startsWith('    [0] button Deep')).toBe(true);
    // Depth cap: rows never indent past 24.
    const capped = elementRow(0, makeEl({ depth: 40, title: 'X' }));
    expect(capped.startsWith(`${' '.repeat(25)}[0] button X`)).toBe(true);
  });

  it('falls back to the absorbed label as identity and shows both when present', () => {
    const unlabeled = elementRow(1, makeEl({ title: null, label: '用户名' }));
    expect(unlabeled).toContain('[1] button 用户名');
    const emptyName = elementRow(2, makeEl({ title: '', label: '空名回落到 label' }));
    expect(emptyName).toContain('button 空名回落到 label');
    const both = elementRow(3, makeEl({ title: 'Search', label: '搜索框旁的说明文字' }));
    expect(both).toContain('button Search label:"搜索框旁的说明文字"');
  });

  it('renders toggle state, offscreen and disabled caps', () => {
    const row = elementRow(
      3,
      makeEl({ role: 'CheckBox', kind: 'checkbox', checked: false, offscreen: true, enabled: false }),
    );
    expect(row).toContain('unchecked');
    expect(row).toContain('offscreen');
    expect(row).toContain('disabled');
    const on = elementRow(4, makeEl({ role: 'CheckBox', kind: 'checkbox', checked: true }));
    expect(on).toContain('checked');
    expect(on).not.toContain('unchecked');
  });

  it('keeps ancestors by real depth when trimming (plan 576)', () => {
    const elements = [
      makeEl({
        native: 'cua-1', probeIndex: 1, depth: 0, kind: '', role: 'Pane',
        title: 'root', actions: [], pressable: false, bounds: [0, 0, 1000, 800],
      }),
      makeEl({
        native: 'cua-2', probeIndex: 2, depth: 1, kind: '', role: 'Pane',
        title: 'pane', actions: [], pressable: false, bounds: [0, 0, 1000, 800],
      }),
      makeEl({ native: 'cua-3', probeIndex: 3, depth: 2, title: 'leaf-a' }),
      makeEl({ native: 'cua-4', probeIndex: 4, depth: 2, title: 'leaf-b' }),
    ];
    const obs: CuaObservation = {
      stateId: 's-3',
      snapshotMode: 'full',
      app: { pid: 1, bundleId: null, name: null },
      window: { windowId: 1, title: 'W', bounds: [0, 0, 1000, 800] },
      elements,
    };
    const text = formatObservation(obs, { maxElements: 1 });
    // leaf-a wins the priority contest; its depth-0/depth-1 ancestors are
    // kept by the depth walk-back even though their own score is lower.
    expect(text).toContain('[2] button leaf-a');
    expect(text).toContain('[0] pane root');
    expect(text).toContain('[1] pane pane');
    expect(text).toContain('indices are sparse');
  });

  it('renders the observation header and trims with a sparse-index note', () => {
    const elements = Array.from({ length: 5 }, (_, i) =>
      makeEl({ native: `cua-${i}`, probeIndex: i + 1, title: `b${i}` }),
    );
    const obs: CuaObservation = {
      stateId: 's-1',
      snapshotMode: 'full',
      app: { pid: 48412, bundleId: 'E:\\...\\electron.exe', name: 'DUYA' },
      window: { windowId: 62459564, title: 'DUYA', bounds: [511, 73, 1493, 1217] },
      elements,
    };
    const text = formatObservation(obs, { maxElements: 3 });
    expect(text).toContain('app: E:\\...\\electron.exe pid=48412 "DUYA"');
    expect(text).toContain('window: "DUYA" window_id=62459564 bounds=[511,73,1493,1217]');
    expect(text).toContain('elements (3 of 5):');
    expect(text).toContain('indices are sparse');
  });

  it('renders diff advisories', () => {
    const obs: CuaObservation = {
      stateId: 's-2',
      snapshotMode: 'delta',
      app: { pid: 1, bundleId: null, name: null },
      window: { windowId: 1, title: 'W', bounds: null },
      elements: [],
      changes: {
        added: [{ index: 4, role: 'Button', title: 'New' }],
        updated: [
          { index: 2, role: 'Edit', title: 'Field', changes: { value: 'typed' } },
        ],
        removed: [{ role: 'Text', title: 'Gone' }],
        addedCount: 1,
        updatedCount: 1,
        removedCount: 1,
        focusChanged: true,
        focusedTitle: 'Field',
      },
    };
    const text = formatDiff(obs);
    expect(text).toContain('+ [4] button New');
    expect(text).toContain('~ [2] textfield Field (value)');
    expect(text).toContain('- text Gone');
    expect(text).toContain('focus: Field');
  });
});

describe('CuaError', () => {
  it('maps codes to retry semantics and defaults actionSent to false', () => {
    const stale = new CuaError('gone', { code: 'ELEMENT_UNAVAILABLE' });
    expect(stale.retry).toBe('reobserve');
    expect(stale.actionSent).toBe(false);

    const possiblySent = new CuaError('maybe', { code: 'TIMEOUT', actionSent: true });
    expect(possiblySent.actionSent).toBe(true);
    expect(possiblySent.retry).toBe('reobserve');

    expect(new CuaError('busy', { code: 'CONTROLLER_BUSY' }).retry).toBe('never');
    expect(new CuaError('nope', { code: 'NOT_SELECTABLE' }).retry).toBe('never');
    expect(new CuaError('boom').retry).toBe('retry');
  });
});
