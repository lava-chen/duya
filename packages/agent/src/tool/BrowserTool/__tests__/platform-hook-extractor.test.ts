import { describe, it, expect } from 'vitest';
import { PlatformHookManager } from '../platform-hooks/PlatformHookManager.js';

/**
 * Regression tests for the generic-extractor wiring bug.
 *
 * `indexExtractors` probes each extractor against a small sample-host list.
 * The article extractor matches every http(s) URL, so it used to be marked
 * `indexed` by the `example.com` probe and never became the `defaultExtractor`.
 * As a result `getExtractor()` returned null for ordinary sites and the caller
 * fell back to a structured DOM snapshot instead of readable text.
 */
describe('PlatformHookManager generic extractor wiring', () => {
  const mgr = new PlatformHookManager();

  it('resolves the article fallback for arbitrary hosts', () => {
    expect(mgr.getExtractor('https://finance.sina.com.cn/')?.name).toBe('article');
    expect(mgr.getExtractor('https://wallstreetcn.com/articles/123')?.name).toBe('article');
    expect(mgr.getExtractor('https://news.qq.com/rain/a/20260101A0001')?.name).toBe('article');
    expect(mgr.getExtractor('https://some-random-blog.io/post/1')?.name).toBe('article');
    expect(mgr.getExtractor('https://example.com/')?.name).toBe('article');
  });

  it('reports an extractor for every http(s) URL', () => {
    expect(mgr.hasExtractor('https://finance.sina.com.cn/')).toBe(true);
    expect(mgr.hasExtractor('https://some-random-blog.io/post/1')).toBe(true);
  });

  it('still prefers platform-specific extractors for known hosts', () => {
    expect(mgr.getExtractor('https://github.com/lava-chen/duya')?.name).toBe('github');
    expect(mgr.getExtractor('https://en.wikipedia.org/wiki/Hydrology')?.name).toBe('wikipedia');
    expect(mgr.getExtractor('https://news.ycombinator.com/item?id=1')?.name).toBe('hacker-news');
  });

  it('keeps the linear-scan fallback for extractors off the sample list', () => {
    expect(mgr.getExtractor('https://arxiv.org/abs/2304.03271')?.name).toBe('arxiv');
  });

  it('returns null for non-http input', () => {
    expect(mgr.getExtractor('about:blank')).toBeNull();
    expect(mgr.getExtractor('file:///E:/tmp/page.html')).toBeNull();
    expect(mgr.hasExtractor('not a url')).toBe(false);
  });
});
