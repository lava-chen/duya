/**
 * Unit tests for the browser `search` operation (plan 428 Phase 1).
 * Covers: deterministic engine selection, SERP URL building, result
 * truncation, DuckDuckGo HTML parsing + redirect resolution, action
 * execution paths (browser success / full-chain failure escalation),
 * and the ResultFormatter output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

import axios from 'axios';
import {
  searchAction,
  selectEngines,
  buildSerpUrl,
  truncateResults,
  resolveDdgLink,
  parseDuckDuckGoHtml,
  parseBingHtml,
  hasCJK,
  type SearchItem,
} from '../actions/search.js';
import type { ActionContext } from '../actions/types.js';
import { formatResult } from '../ResultFormatter.js';

const mockedAxiosGet = vi.mocked(axios.get);

function buildCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    cdp: null,
    snapshotEngine: null,
    fallbackBrowser: null,
    mode: 'extension',
    browserBackendMode: 'auto',
    extensionAvailable: true,
    platformHookManager: {
      shouldApplyHooks: () => false,
      applyPostNavigateHooks: async () => {},
      hasExtractor: () => false,
      extractContent: async () => null,
    },
    checkDomainBlocked: () => false,
    getBrowserPool: () => {
      throw new Error('not needed');
    },
    ...overrides,
  } as ActionContext;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('hasCJK', () => {
  it('detects CJK queries', () => {
    expect(hasCJK('五强溪 水位')).toBe(true);
    expect(hasCJK('node sqlite')).toBe(false);
  });
});

describe('selectEngines', () => {
  it('domestic + CJK query leads with baidu', () => {
    expect(selectEngines('auto', 'domestic', 'React 性能优化')[0]).toBe('baidu');
  });

  it('domestic + English query leads with bing (google unreachable)', () => {
    const chain = selectEngines('auto', 'domestic', 'node sqlite guide');
    expect(chain[0]).toBe('bing');
    // Google stays only as the last-resort fallback (probe may misclassify).
    expect(chain.indexOf('google')).toBe(5);
  });

  it('domestic chain never starts with google', () => {
    const chain = selectEngines('auto', 'domestic', 'english query');
    expect(chain[0]).not.toBe('google');
  });

  it('overseas leads with google', () => {
    expect(selectEngines('auto', 'overseas', 'node sqlite guide')[0]).toBe('google');
  });

  it('unknown leads with bing (reachable from both sides)', () => {
    expect(selectEngines('auto', undefined, 'anything')[0]).toBe('bing');
    expect(selectEngines('auto', 'unknown', 'anything')[0]).toBe('bing');
  });

  it('explicit engine always goes first, others follow as fallback', () => {
    const chain = selectEngines('baidu', 'overseas', 'node sqlite');
    expect(chain[0]).toBe('baidu');
    expect(chain).toHaveLength(6);
    expect(new Set(chain).size).toBe(6);
  });
});

describe('buildSerpUrl', () => {
  it('encodes queries for every engine', () => {
    const q = 'c++ move semantics';
    expect(buildSerpUrl('google', q, 8)).toBe(
      `https://www.google.com/search?q=${encodeURIComponent(q)}&num=8&hl=en`,
    );
    expect(buildSerpUrl('bing', q, 5)).toBe(
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=5`,
    );
    expect(buildSerpUrl('baidu', q, 20)).toBe(
      `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=20`,
    );
    expect(buildSerpUrl('duckduckgo', q, 8)).toBe(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    );
    expect(buildSerpUrl('brave', q, 8)).toBe(
      `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    );
    expect(buildSerpUrl('yahoo', q, 8)).toBe(
      `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
    );
  });

  it('caps baidu rn at 20', () => {
    expect(buildSerpUrl('baidu', 'q', 50)).toContain('rn=20');
  });
});

describe('truncateResults', () => {
  const items: SearchItem[] = [
    { rank: 0, title: 'a', url: 'https://a.com', snippet: '' },
    { rank: 0, title: '', url: 'https://b.com', snippet: '' }, // no title → dropped
    { rank: 0, title: 'c', url: '', snippet: '' },             // no url → dropped
    { rank: 0, title: 'd', url: 'https://d.com', snippet: '' },
    { rank: 0, title: 'e', url: 'https://e.com', snippet: '' },
  ];

  it('drops invalid entries, caps length, and re-ranks from 1', () => {
    const out = truncateResults(items, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ rank: 1, title: 'a' });
    expect(out[1]).toMatchObject({ rank: 2, title: 'd' });
  });
});

describe('resolveDdgLink', () => {
  it('decodes uddg redirect param', () => {
    const target = 'https://example.com/a?b=1&c=2';
    const href = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
    expect(resolveDdgLink(href)).toBe(target);
  });

  it('handles protocol-relative links', () => {
    expect(resolveDdgLink('//example.com/x')).toBe('https://example.com/x');
  });

  it('passes through plain links', () => {
    expect(resolveDdgLink('https://example.com/plain')).toBe('https://example.com/plain');
  });
});

describe('parseBingHtml', () => {
  const sampleHtml = `
    <li class="b_algo" data-id iid=SERP.1>
      <h2><a href="https://nodejs.org/" h="ID=SERP">Node.js — Run JavaScript <b>Everywhere</b></a></h2>
      <div class="b_caption"><p class="b_lineclamp4">Node.js® is a free, open-source runtime.</p></div>
    </li>
    <li class="b_algo" data-id iid=SERP.2>
      <h2><a href="https://www.bing.com/search?q=internal">Internal link (skipped)</a></h2>
      <p class="b_lineclamp2">should be skipped</p>
    </li>
    <li class="b_algo" data-id iid=SERP.3>
      <h2><a href="https://github.com/nodejs/node">GitHub - nodejs/node</a></h2>
      <div class="b_caption"><p>Node.js JavaScript runtime :rocket:</p></div>
    </li>
  `;

  it('extracts titles, urls, and snippets from b_algo blocks', () => {
    const items = parseBingHtml(sampleHtml, 8);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Node.js — Run JavaScript Everywhere',
      url: 'https://nodejs.org/',
      snippet: 'Node.js® is a free, open-source runtime.',
    });
    expect(items[1]).toMatchObject({ title: 'GitHub - nodejs/node', url: 'https://github.com/nodejs/node' });
  });

  it('respects maxResults and returns empty for non-SERP html', () => {
    expect(parseBingHtml(sampleHtml, 1)).toHaveLength(1);
    expect(parseBingHtml('<html><body>hello</body></html>', 8)).toEqual([]);
  });
});

describe('parseDuckDuckGoHtml', () => {
  const sampleHtml = `
    <div class="result results_links">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fstream.html&amp;rut=xyz">
        Node.js &amp; Streams API
      </a>
      <a class="result__snippet" href="...">Stream &lt;backpressure&gt; guide</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://v8.dev/blog">V8 blog</a>
      <a class="result__snippet" href="...">V8 release notes</a>
    </div>
  `;

  it('extracts titles, resolved urls, and snippets', () => {
    const items = parseDuckDuckGoHtml(sampleHtml, 8);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Node.js & Streams API',
      url: 'https://nodejs.org/api/stream.html',
      snippet: 'Stream <backpressure> guide',
    });
    expect(items[1]).toMatchObject({
      title: 'V8 blog',
      url: 'https://v8.dev/blog',
    });
  });

  it('respects maxResults', () => {
    expect(parseDuckDuckGoHtml(sampleHtml, 1)).toHaveLength(1);
  });

  it('returns empty for non-SERP html', () => {
    expect(parseDuckDuckGoHtml('<html><body>hello</body></html>', 8)).toEqual([]);
  });
});

// ─── Action execution ───────────────────────────────────────────────────────

describe('searchAction.execute', () => {
  beforeEach(() => {
    mockedAxiosGet.mockReset();
  });

  it('returns structured results from the first healthy engine via browser', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'ok',
      results: [
        { title: 't1', url: 'https://t1.com', snippet: 's1' },
        { title: 't2', url: 'https://t2.com', snippet: 's2' },
      ],
    });
    const navigate = vi.fn();
    const ctx = buildCtx({
      cdp: { navigate, evaluate } as unknown as ActionContext['cdp'],
      networkEnvironment: 'overseas',
    });

    const result = await searchAction.execute(
      { query: 'node streams', engine: 'auto', maxResults: 8 },
      ctx,
    );

    expect(result['success']).toBe(true);
    expect(result['engineUsed']).toBe('google');
    expect(result['networkEnvironment']).toBe('overseas');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('google.com/search'));
    const results = result['results'] as SearchItem[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ rank: 1, title: 't1', url: 'https://t1.com' });
  });

  it('degrades to the next engine when extraction returns nothing', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'error', detail: 'blocked by consent/captcha page' })
      .mockResolvedValueOnce({
        kind: 'ok',
        results: [{ title: 'bing-hit', url: 'https://b.com', snippet: '' }],
      });
    const navigate = vi.fn();
    const ctx = buildCtx({
      cdp: { navigate, evaluate } as unknown as ActionContext['cdp'],
      networkEnvironment: 'overseas',
    });

    const result = await searchAction.execute(
      { query: 'q', engine: 'auto', maxResults: 8 },
      ctx,
    );

    expect(result['success']).toBe(true);
    expect(result['engineUsed']).toBe('bing');
    expect(navigate).toHaveBeenCalledTimes(2);
    const attempts = result['attempts'] as Array<{ engine: string; error: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].engine).toBe('google');
  });

  it('probes the network when ctx has no cached environment and syncs it back', async () => {
    const { setNetworkEnvironmentForTest, resetNetworkEnvironmentCache } = await import(
      '../networkEnv.js'
    );
    resetNetworkEnvironmentCache();
    setNetworkEnvironmentForTest('domestic');

    const sync = vi.fn();
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'ok',
      results: [{ title: 't', url: 'https://t.com', snippet: '' }],
    });
    const ctx = buildCtx({
      cdp: { navigate: vi.fn(), evaluate } as unknown as ActionContext['cdp'],
      setNetworkEnvironment: sync,
    });

    const result = await searchAction.execute({ query: '测试', engine: 'auto', maxResults: 8 }, ctx);

    expect(result['networkEnvironment']).toBe('domestic');
    expect(result['engineUsed']).toBe('baidu'); // domestic + CJK → baidu leads
    expect(sync).toHaveBeenCalledWith('domestic');
    resetNetworkEnvironmentCache();
  });

  it('falls back to the HTTP duckduckgo endpoint when no browser backend exists', async () => {
    mockedAxiosGet.mockResolvedValue({
      data: `<div class="result">
        <a rel="nofollow" class="result__a" href="https://ddg-hit.com">DDG hit</a>
        <a class="result__snippet" href="...">snippet</a>
      </div>`,
    });

    const result = await searchAction.execute(
      { query: 'q', engine: 'auto', maxResults: 8 },
      buildCtx({ networkEnvironment: 'overseas' }),
    );

    expect(result['success']).toBe(true);
    expect(result['engineUsed']).toBe('duckduckgo');
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('html.duckduckgo.com'),
      expect.anything(),
    );
  });

  it('escalates with attempts + nextSteps when every engine fails', async () => {
    mockedAxiosGet.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const evaluate = vi.fn().mockResolvedValue({ kind: 'error', detail: 'no results parsed on SERP' });

    const result = await searchAction.execute(
      { query: 'q', engine: 'auto', maxResults: 8 },
      buildCtx({
        cdp: { navigate: vi.fn(), evaluate } as unknown as ActionContext['cdp'],
        networkEnvironment: 'overseas',
      }),
    );

    expect(result['success']).toBe(false);
    // overseas chain google→bing→ddg→brave→yahoo→baidu via browser (6), then bing+ddg via http (2)
    const attempts = result['attempts'] as Array<{ engine: string; path: string }>;
    expect(attempts.length).toBe(8);
    expect(attempts[6]).toMatchObject({ engine: 'bing', path: 'http' });
    expect(attempts[7]).toMatchObject({ engine: 'duckduckgo', path: 'http' });
    const nextSteps = result['nextSteps'] as string[];
    expect(nextSteps.length).toBeGreaterThan(0);
    expect(String(result['error'])).toContain('All search engines failed');
  });
});

// ─── ResultFormatter ────────────────────────────────────────────────────────

describe('formatResult search', () => {
  it('renders a compact ranked list on success', () => {
    const out = formatResult('search', {
      success: true,
      query: 'node streams',
      engineUsed: 'google',
      networkEnvironment: 'overseas',
      results: [
        { rank: 1, title: 'Node streams', url: 'https://nodejs.org', snippet: 'API docs' },
      ],
    });
    expect(out).toContain('### Search Results');
    expect(out).toContain('Engine: google (network: overseas)');
    expect(out).toContain('1. **Node streams**');
    expect(out).toContain('https://nodejs.org');
  });

  it('renders attempts and next steps on failure', () => {
    const out = formatResult('search', {
      success: false,
      query: 'q',
      error: 'All search engines failed (google/browser, duckduckgo/http)',
      attempts: [{ engine: 'google', path: 'browser', error: 'no results parsed on SERP' }],
      nextSteps: ['Retry once with an explicit engine'],
    });
    expect(out).toContain('### Search Failed');
    expect(out).toContain('google/browser: no results parsed on SERP');
    expect(out).toContain('- Retry once with an explicit engine');
  });
});
