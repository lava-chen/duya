import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { FallbackBrowser } from '../../src/tool/BrowserTool/FallbackBrowser.js';

describe('FallbackBrowser local HTML navigation', () => {
  it('loads file:// HTML inside the working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duya-fallback-root-'));
    const pagePath = join(root, 'page.html');
    await writeFile(
      pagePath,
      '<html><head><title>Local Page</title></head><body><main><h1>Hello local HTML</h1><button>Run</button></main></body></html>',
      'utf8',
    );

    const browser = new FallbackBrowser(root);
    const result = await browser.navigate(pathToFileURL(pagePath).href);

    expect(result.title).toBe('Local Page');
    expect(result.snapshot).toContain('Hello local HTML');
    expect(result.interactiveElements).toEqual([
      { ref: 1, tag: 'button', text: 'Run' },
    ]);
  });

  it('blocks file:// navigation outside the working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duya-fallback-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'duya-fallback-outside-'));
    const pagePath = join(outside, 'page.html');
    await writeFile(pagePath, '<html><body>secret</body></html>', 'utf8');

    const browser = new FallbackBrowser(root);
    const result = await browser.navigate(pathToFileURL(pagePath).href);

    expect(result.title).toBe('Blocked');
    expect(result.snapshot).toContain('outside the working directory');
  });

  it('blocks non-HTML local files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duya-fallback-root-'));
    const dataPath = join(root, 'data.txt');
    await writeFile(dataPath, 'plain text', 'utf8');

    const browser = new FallbackBrowser(root);
    const result = await browser.navigate(pathToFileURL(dataPath).href);

    expect(result.title).toBe('Blocked');
    expect(result.snapshot).toContain('Unsupported local file type');
  });

  it('uses the last loaded local page for empty snapshot navigation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duya-fallback-root-'));
    await mkdir(join(root, 'nested'));
    const pagePath = join(root, 'nested', 'page.html');
    await writeFile(pagePath, '<html><body><p>cached page</p></body></html>', 'utf8');

    const browser = new FallbackBrowser(root);
    await browser.navigate(pathToFileURL(pagePath).href);
    const result = await browser.navigate('');

    expect(result.snapshot).toContain('cached page');
  });
});
