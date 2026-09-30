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

describe('BrowserTool usage guide (plan 583 Phase 2)', () => {
  // The operating manual is ~20 KB and is now surfaced through
  // `tool_catalog`'s detail response, so it is model-visible for the first
  // time. If the engine ever stops producing it, the model silently loses
  // all browser guidance — this test is the tripwire for that.
  it('exposes a substantial, browser-specific operating manual', () => {
    const guide = new BrowserTool().getPrompt();

    expect(guide.length).toBeGreaterThan(5_000);
    expect(guide).toContain('browser');
    // Documents real operations rather than restating the tool description.
    expect(guide).toMatch(/snapshot/);
    expect(guide).toMatch(/navigate/);
  });

  it('is reachable through the registry executor contract', () => {
    // `getPrompt?()` is optional on ToolExecutor; the catalog detail path
    // calls it via that interface, so it must exist on the registered object.
    const tool = new BrowserTool();
    expect(typeof (tool as { getPrompt?: () => string }).getPrompt).toBe('function');
  });
});

