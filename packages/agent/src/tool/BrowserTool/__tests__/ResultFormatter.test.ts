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

const parallelResult: Record<string, unknown> = {
  operation: 'parallel_fetch',
  results: [
    {
      id: 'invest_0',
      url: 'https://a.com',
      title: 'A',
      success: true,
      compactSnapshot: '- a [ref=1] "标题A"',
      interactiveElements: [{ ref: 1, tag: 'a', text: '标题A' }],
    },
    {
      id: 'invest_1',
      url: 'https://b.com',
      title: 'B',
      success: true,
      compactSnapshot: '- span "简介B"',
    },
  ],
  total: 2,
  successful: 2,
  mode: 'browser_pool',
};

describe('formatResult parallel_fetch projection', () => {
  it('drops the full Snapshot section from each parallel item', () => {
    const out = formatResult('parallel_fetch', parallelResult);
    expect(out).toContain('### Parallel Fetch Results');
    expect(out).toContain('### Summary');
    expect(out).toContain('### Visible Text');
    expect(out).not.toContain('### Snapshot');
    expect(out).toMatch(/标题A/);
    expect(out).toMatch(/简介B/);
  });
});