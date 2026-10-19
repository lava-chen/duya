// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  extractBrowserResults,
  describeBrowserOperation,
  extractEngineText,
  BrowserToolRow,
} from '../rows/BrowserToolRow';
import type { ToolAction } from '../types';

const tool = (over: Partial<ToolAction>): ToolAction => ({
  name: 'browser',
  input: {},
  ...over,
});

describe('extractBrowserResults', () => {
  it('parses parallel_fetch markdown into multiple items', () => {
    const result = [
      '### Parallel Fetch Results',
      '#### [invest_0] https://a.com',
      '**Title**: A',
      '#### [invest_1] https://b.com',
      '**Title**: B',
    ].join('\n');
    const items = extractBrowserResults(tool({ result }));
    expect(items.map((i) => i.url)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('parses a single navigate page', () => {
    const result = '### Page\n- URL: https://example.com\n- Title: Example';
    const items = extractBrowserResults(tool({ result }));
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://example.com');
  });

  it('parses a JSON results envelope', () => {
    const result = JSON.stringify({ results: [{ url: 'https://x.com', title: 'X' }] });
    const items = extractBrowserResults(tool({ result }));
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://x.com');
  });

  it('prefers structured metadata over markdown', () => {
    const result = '### Parallel Fetch Results\n#### [invest_0] https://old.com';
    const items = extractBrowserResults(
      tool({
        result,
        metadata: { browserResults: [{ url: 'https://new.com', title: 'New' }] },
      }),
    );
    expect(items[0].url).toBe('https://new.com');
  });

  it('returns empty for unknown content', () => {
    expect(extractBrowserResults(tool({ result: 'Clicked [ref=3]' }))).toEqual([]);
  });
});

describe('extractEngineText', () => {
  it('prefers engineUsed from the result markdown over the requested input engine', () => {
    const t = tool({
      input: { operation: 'search', query: 'duya', engine: 'auto' },
      result: '### Search Results\n- Engine: baidu (network: domestic)',
    });
    expect(extractEngineText(t)).toBe('百度');
  });

  it('falls back to the requested input engine', () => {
    expect(
      extractEngineText(tool({ input: { operation: 'search', engine: 'bing' } })),
    ).toBe('Bing');
  });

  it('returns undefined for auto/unknown engines', () => {
    expect(
      extractEngineText(tool({ input: { operation: 'search', engine: 'auto' } })),
    ).toBeUndefined();
    expect(
      extractEngineText(tool({ input: { operation: 'search' }, result: '- Engine: unknown' })),
    ).toBeUndefined();
  });
});

describe('BrowserToolRow navigate rendering', () => {
  it('renders a navigate action as a single page link, not a search card', () => {
    const input = {
      operation: 'navigate',
      url: 'https://example.com',
    };
    const result = '### Page\n- URL: https://example.com\n- Title: Example';
    render(<BrowserToolRow tool={tool({ input, result })} />);

    // Page link surfaced directly — no "搜索「…」" search header.
    expect(screen.queryByText(/搜索「/)).toBeNull();
    const link = screen.getByRole('link', { name: /Example/ });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(screen.getByText('example.com')).toBeTruthy();
  });

  it('renders a go_back action as a page link', () => {
    const input = { operation: 'go_back' };
    const result = '### Page\n- URL: https://example.com/2\n- Title: Two';
    render(<BrowserToolRow tool={tool({ input, result })} />);

    expect(screen.queryByText(/搜索「/)).toBeNull();
    expect(screen.getByRole('link', { name: /Two/ })).toBeTruthy();
  });

  it('renders navigate with empty result as a plain status row (no search header)', () => {
    const input = { operation: 'navigate', url: 'https://example.com' };
    render(<BrowserToolRow tool={tool({ input })} />);
    expect(screen.queryByText(/搜索「/)).toBeNull();
    expect(screen.getByText('已打开页面')).toBeTruthy();
  });
});

describe('BrowserToolRow non-search actions', () => {
  it('renders click/type/screenshot as a plain status row with Chinese verb, not a search card', () => {
    const input = { operation: 'click', ref: '@3' };
    render(<BrowserToolRow tool={tool({ input, result: 'Clicked [ref=3]' })} />);
    expect(screen.queryByText(/搜索「/)).toBeNull();
    expect(screen.getByText('已点击')).toBeTruthy();
  });

  it('renders scroll with its Chinese verb description', () => {
    render(<BrowserToolRow tool={tool({ input: { operation: 'scroll' }, result: 'scrolled' })} />);
    expect(screen.getByText('已下滑页面')).toBeTruthy();
  });
});

describe('BrowserToolRow search card', () => {
  it('shows query and engine badge in the header', () => {
    const input = { operation: 'search', query: 'duya', engine: 'auto' };
    const result = [
      '### Search Results',
      '- Query: duya',
      '- Engine: google (network: overseas)',
      '',
      '1. **Duya official**',
      '   https://duya.example.com',
    ].join('\n');
    render(<BrowserToolRow tool={tool({ input, result })} />);
    expect(screen.getByText('搜索「duya」')).toBeTruthy();
    expect(screen.getByText('Google')).toBeTruthy();
  });

  it('expands to render the raw result markdown (envelope stripped)', () => {
    const input = { operation: 'search', query: 'duya' };
    const result = [
      '[completed] browser',
      '### Search Results',
      '- Query: duya',
      '- Engine: bing (network: overseas)',
      '',
      '1. **Duya official**',
      '   https://duya.example.com',
      '',
      '[Duration: 1200ms]',
    ].join('\n');
    render(<BrowserToolRow tool={tool({ input, result })} />);

    // Collapsed: content hidden.
    expect(screen.queryByText('Duya official')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Duya official')).toBeTruthy();
    // Envelope lines are stripped — not visible in the card.
    expect(screen.queryByText('[completed] browser')).toBeNull();
    expect(screen.queryByText('[Duration: 1200ms]')).toBeNull();
  });

  it('expands to render parallel_fetch markdown with its result links', () => {
    const input = { operation: 'parallel_fetch', urls: ['https://a.com', 'https://b.com'] };
    const result = [
      '[completed] browser',
      '### Parallel Fetch Results',
      'Total: 2 | Success: 2 | Failed: 0',
      '',
      '#### [invest_0] https://a.com',
      '**Title**: A page',
      '',
      '#### [invest_1] https://b.com',
      '**Title**: B page',
      '',
      '[Duration: 900ms]',
    ].join('\n');
    render(<BrowserToolRow tool={tool({ input, result })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/A page/)).toBeTruthy();
    expect(screen.getByText(/B page/)).toBeTruthy();
  });

  it('does not expand while running', () => {
    const input = { operation: 'search', query: 'duya' };
    render(<BrowserToolRow tool={tool({ input })} />);
    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('describeBrowserOperation', () => {
  it('maps known operations to Chinese descriptions', () => {
    expect(describeBrowserOperation('scroll')).toBe('已下滑页面');
    expect(describeBrowserOperation('snapshot')).toBe('已获取页面结构');
    expect(describeBrowserOperation('screenshot')).toBe('已截图');
  });

  it('falls back to the raw operation name for unknown operations', () => {
    expect(describeBrowserOperation('unknown_op')).toBe('unknown_op');
  });
});

describe('BrowserToolRow hook order stability', () => {
  // Regression test: the component used to call a `useMemo` for
  // `displayResult` after an early `return`, which made the hook count
  // depend on the operation type. React then threw "Rendered more hooks
  // than during the previous render" when a tool's operation type
  // changed between renders (e.g. when SSE streamed in a search result
  // after a navigate had already mounted).
  it('does not throw when the operation type changes between renders', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // First render: a `navigate` action — takes the early-return path and
    // calls 4 hooks.
    const navigateTool = tool({
      input: { operation: 'navigate', url: 'https://example.com' },
      result: '### Page\n- URL: https://example.com\n- Title: Example',
    });
    const view = render(<BrowserToolRow tool={navigateTool} />);
    expect(screen.getByRole('link', { name: /Example/ })).toBeTruthy();

    // Second render: a `search` action — used to call 5 hooks and crash
    // because React had seen only 4 in the previous render.
    const searchTool = tool({
      input: { operation: 'search', query: 'duya' },
      result: '### Search Results\n- Query: duya',
    });
    expect(() => view.rerender(<BrowserToolRow tool={searchTool} />)).not.toThrow();
    expect(screen.getByText('搜索「duya」')).toBeTruthy();

    // Third render: back to a non-search action. Must also be stable.
    const clickTool = tool({
      input: { operation: 'click', ref: '@3' },
      result: 'Clicked [ref=3]',
    });
    expect(() => view.rerender(<BrowserToolRow tool={clickTool} />)).not.toThrow();
    expect(screen.getByText('已点击')).toBeTruthy();

    const hookWarnings = errorSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === 'string' && /Rendered (more|fewer) hooks/.test(first);
    });
    expect(hookWarnings).toHaveLength(0);

    errorSpy.mockRestore();
  });
});
