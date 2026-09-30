import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ICDPClient } from '../../CDPClient.js';
import { articleExtractor } from '../article/index.js';
import { wikipediaExtractor } from '../wikipedia/index.js';
import { hackerNewsExtractor } from '../hacker-news/index.js';
import { pubmedExtractor } from '../pubmed/index.js';

const dummyCdp = {} as ICDPClient;

function mockFetchJsonOnce(respond: (url: string) => { ok: boolean; status: number; data: unknown }): void {
  const fn = vi.fn(async (url: string) => {
    const r = respond(String(url));
    return {
      ok: r.ok,
      status: r.status,
      text: async () => (r.data === undefined || r.data === null ? '' : JSON.stringify(r.data)),
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('article extractor', () => {
  it('matches http(s) urls but not schema-less ones', () => {
    expect(articleExtractor.matches('https://example.com/post')).toBe(true);
    expect(articleExtractor.matches('http://example.com')).toBe(true);
    expect(articleExtractor.matches('about:blank')).toBe(false);
  });
});

describe('wikipedia extractor', () => {
  it('matches en/zh wikipedia hosts', () => {
    expect(wikipediaExtractor.matches('https://en.wikipedia.org/wiki/Transformer')).toBe(true);
    expect(wikipediaExtractor.matches('https://zh.wikipedia.org/wiki/词')).toBe(true);
    expect(wikipediaExtractor.matches('https://example.com/x')).toBe(false);
  });

  it('renders title, description and body from the API', async () => {
    mockFetchJsonOnce(() => ({
      ok: true,
      status: 200,
      data: {
        query: { pages: [{ title: 'Transformer', description: 'ML model', extract: 'It is a neural network architecture.' }] },
      },
    }));
    const out = await wikipediaExtractor.extract(dummyCdp, 'https://en.wikipedia.org/wiki/Transformer');
    expect(out.success).toBe(true);
    expect(out.text).toContain('# Transformer');
    expect(out.text).toContain('> ML model');
    expect(out.text).toContain('neural network architecture');
  });
});

describe('hacker-news extractor', () => {
  it('matches news.ycombinator.com', () => {
    expect(hackerNewsExtractor.matches('https://news.ycombinator.com/item?id=123')).toBe(true);
    expect(hackerNewsExtractor.matches('https://example.com')).toBe(false);
  });

  it('renders story plus threaded comments', async () => {
    mockFetchJsonOnce((url) => {
      if (url.includes('/item/1.json')) {
        return { ok: true, status: 200, data: { id: '1', title: 'Intro to SQLite', by: 'alice', score: 5, kids: ['2', '3'] } };
      }
      if (url.includes('/item/2.json')) {
        return { ok: true, status: 200, data: { id: '2', by: 'bob', text: 'Great post <a href="http://x">link</a>.' } };
      }
      return { ok: true, status: 200, data: { id: '3', by: 'carol', text: 'Thanks for sharing.' } };
    });
    const out = await hackerNewsExtractor.extract(dummyCdp, 'https://news.ycombinator.com/item?id=1');
    expect(out.success).toBe(true);
    expect(out.text).toContain('# Intro to SQLite');
    expect(out.text).toContain('bob');
    expect(out.text).toMatch(/Great post .*link/);
    expect(out.text).toContain('Thanks for sharing');
  });
});

describe('pubmed extractor', () => {
  it('matches pubmed.ncbi.nlm.nih.gov', () => {
    expect(pubmedExtractor.matches('https://pubmed.ncbi.nlm.nih.gov/37780221/')).toBe(true);
    expect(pubmedExtractor.matches('https://example.com')).toBe(false);
  });

  it('renders PMID metadata from esummary', async () => {
    mockFetchJsonOnce(() => ({
      ok: true,
      status: 200,
      data: {
        result: {
          '123': {
            uid: '123',
            title: 'A study of ducks',
            authors: [{ name: 'Ada L' }, { name: 'Bob K' }, { name: 'Cy T' }, { name: 'Dan P' }],
            fulljournalname: 'Journal of Avian Science',
            pubdate: '2024 Feb',
            pubtype: ['Journal Article'],
            articleids: [{ idtype: 'doi', value: '10.1234/duck' }],
          },
        },
      },
    }));
    const out = await pubmedExtractor.extract(dummyCdp, 'https://pubmed.ncbi.nlm.nih.gov/123/');
    expect(out.success).toBe(true);
    expect(out.text).toContain('# A study of ducks');
    expect(out.text).toContain('**PMID:** 123');
    expect(out.text).toContain('Ada L, Bob K, Cy T et al.');
    expect(out.text).toContain('**DOI:** 10.1234/duck');
  });
});