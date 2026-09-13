import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: mocks.get },
}));

// Path is relative to THIS test file, not the source file.
vi.mock('../../../utils/urlSafety.js', () => ({
  isSafeUrl: async () => ({ safe: true }),
}));

import { ParallelFetcher } from '../ParallelFetcher.js';

const PAGE = `
<html>
  <head>
    <title>Hydrology</title>
    <style>body { color: red }</style>
  </head>
  <body>
    <nav><a href="/">Home</a></nav>
    <article>
      <h1>Design Flood</h1>
      <p>Peak discharge is 291 m3/s.</p>
      <ul><li>Rainfall</li><li>Runoff</li></ul>
    </article>
    <script>var tracking = 1;</script>
  </body>
</html>
`;

describe('ParallelFetcher static path returns plain text, not structure', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({ data: PAGE });
  });

  it('strips tags and keeps readable content', async () => {
    const fetcher = new ParallelFetcher();
    const [result] = await fetcher.fetchBatch([{ id: 't0', url: 'https://example.com/' }]);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Design Flood');
    expect(result.content).toContain('Peak discharge is 291 m3/s.');
    expect(result.content).toContain('Rainfall');
    expect(result.content).toContain('Runoff');
  });

  it('never leaks tags, scripts or styles', async () => {
    const fetcher = new ParallelFetcher();
    const [result] = await fetcher.fetchBatch([{ id: 't0', url: 'https://example.com/' }]);

    const content = result.content ?? '';
    expect(content).not.toMatch(/<[a-z]/i);
    expect(content).not.toContain('var tracking');
    expect(content).not.toContain('color: red');
    expect(content).not.toContain('href=');
  });

  it('recovers text that lives only in element.raw', async () => {
    // Regression guard: parseHtmlSimple stores an element's own text in `raw`
    // (never in `children`), so a naive walker drops every paragraph.
    mocks.get.mockResolvedValue({
      data: '<html><head><title>Raw</title></head><body><p>Alone in a paragraph that carries plenty of readable characters.</p><div><span>In a span element too.</span></div></body></html>',
    });

    const fetcher = new ParallelFetcher();
    const [result] = await fetcher.fetchBatch([{ id: 't0', url: 'https://example.com/' }]);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Alone in a paragraph that carries plenty of readable characters.');
    expect(result.content).toContain('In a span element too.');
  });
});
