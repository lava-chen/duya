import { describe, it, expect } from 'vitest';
import { formatResult } from '../ResultFormatter.js';

const navResult: Record<string, unknown> = {
  operation: 'navigate',
  url: 'https://example.com',
  title: 'Example',
  mode: 'extension',
  compactSnapshot: [
    '- div:',
    '  - a [ref=1] href="/login" "登录"',
    '  - button [ref=2] "搜索"',
    '  - span "今日热榜"',
    '  - text: "欢迎回来"',
  ].join('\n'),
  interactiveElements: [
    { ref: 1, tag: 'a', text: '登录' },
    { ref: 2, tag: 'button', text: '搜索' },
  ],
};

describe('formatResult navigate projection', () => {
  it('drops the full Snapshot section from navigate output', () => {
    const out = formatResult('navigate', navResult);
    expect(out).toContain('### Page');
    expect(out).toContain('### Summary');
    expect(out).toContain('### Visible Text');
    expect(out).toContain('### Actions (2)');
    expect(out).not.toContain('### Snapshot');
    expect(out).toContain('snapshot');
  });

  it('extracts and dedupes visible text from the snapshot', () => {
    const out = formatResult('navigate', navResult);
    expect(out).toMatch(/登录/);
    expect(out).toMatch(/搜索/);
    expect(out).toMatch(/今日热榜/);
    expect(out).toMatch(/欢迎回来/);
  });

  it('go_back with no snapshot emits only Page + hint', () => {
    const out = formatResult('go_back', {
      operation: 'go_back',
      url: 'https://example.com/2',
      title: 'Two',
      mode: 'extension',
    });
    expect(out).toContain('### Page');
    expect(out).not.toContain('### Visible Text');
    expect(out).not.toContain('### Actions');
    expect(out).toContain('snapshot');
  });

  it('omits Actions when there are no interactive elements', () => {
    const out = formatResult('navigate', { ...navResult, interactiveElements: [] });
    expect(out).not.toContain('### Actions');
  });
});