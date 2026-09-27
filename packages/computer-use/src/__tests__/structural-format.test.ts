import { describe, expect, it } from 'vitest';

import { emptyTreeHint, formatTreeElement, formatTreeForLlm } from '../som/structural-format.js';
import type { UiaTreeElement, UiaTreeResult } from '../backend/types.js';

function el(overrides: Partial<UiaTreeElement> = {}): UiaTreeElement {
  return {
    index: 1,
    role: 'Button',
    name: '登录',
    rect: { x: 10, y: 20, w: 100, h: 32 },
    ...overrides,
  };
}

function tree(elements: UiaTreeElement[], overrides: Partial<UiaTreeResult> = {}): UiaTreeResult {
  return {
    hwnd: 197144,
    title: 'Sign in - Portal',
    processName: 'chrome',
    elements,
    truncated: false,
    reason: null,
    source: 'uia-tree',
    ...overrides,
  };
}

describe('structural-format — formatTreeElement', () => {
  it('renders index, role, name and rect', () => {
    expect(formatTreeElement(el())).toBe('[1]Button "登录" @(10,20 100x32)');
  });

  it('appends value for text controls and masks passwords', () => {
    expect(formatTreeElement(el({ role: 'Edit', name: 'User', value: 'alice' }))).toContain(
      'value="alice"',
    );
    expect(formatTreeElement(el({ role: 'Edit', name: 'PW', value: 'secret', isPassword: true }))).toContain(
      '*pw',
    );
    expect(
      formatTreeElement(el({ role: 'Edit', name: 'PW', value: 'secret', isPassword: true })),
    ).not.toContain('secret');
  });

  it('quotes inner double quotes and truncates long values', () => {
    const line = formatTreeElement(el({ name: 'He said "hi" to me — and kept going far beyond the eighty character budget' }));
    expect(line).toContain('"He said \'hi\'');
    const long = formatTreeElement(el({ value: 'x'.repeat(100) }));
    expect(long).toMatch(/value="x{39}…"/);
  });
});

describe('structural-format — formatTreeForLlm', () => {
  it('renders a header with window identity and one line per element', () => {
    const result = formatTreeForLlm(
      tree([el(), el({ index: 2, role: 'Edit', name: 'User', value: 'alice' })]),
    );
    expect(result.elementCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.text.split('\n')[0]).toContain('"Sign in - Portal"');
    expect(result.text.split('\n')[0]).toContain('chrome');
    expect(result.text.split('\n')[1]).toBe('[1]Button "登录" @(10,20 100x32)');
    expect(result.text.split('\n')[2]).toContain('[2]Edit "User"');
  });

  it('marks truncated trees and honors maxElements', () => {
    const many = Array.from({ length: 5 }, (_, i) => el({ index: i + 1, name: `b${i}` }));
    const result = formatTreeForLlm(tree(many, { truncated: true }), { maxElements: 3 });
    expect(result.truncated).toBe(true);
    expect(result.text.split('\n')).toHaveLength(4); // header + 3
  });

  it('empty tree renders the fallback hint instead of a bare list', () => {
    const result = formatTreeForLlm(tree([]));
    expect(result.elementCount).toBe(0);
    expect(result.text).toContain('vision loop');
  });

  it('unavailable channel explains the platform gap', () => {
    const result = formatTreeForLlm(tree([], { source: 'unavailable' }));
    expect(result.text).toContain('unavailable');
  });

  it('elevated windows explain the UIPI skip', () => {
    const result = formatTreeForLlm(tree([], { reason: 'elevated' }));
    expect(result.text).toContain('elevated');
  });
});
