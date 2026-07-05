import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { BrowserTool } from '../../src/tool/BrowserTool/BrowserTool.js';

describe('BrowserTool local file navigation', () => {
  it('routes file:// HTML navigation through fallback without extension setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duya-browser-tool-root-'));
    const pagePath = join(root, 'page.html');
    await writeFile(
      pagePath,
      '<html><head><title>Local BrowserTool Page</title></head><body><main><h1>Local snapshot</h1></main></body></html>',
      'utf8',
    );

    const tool = new BrowserTool();
    const result = await tool.execute(
      { operation: 'navigate', url: pathToFileURL(pagePath).href },
      root,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toContain('Local BrowserTool Page');
    expect(result.result).toContain('Local snapshot');
  });
});
