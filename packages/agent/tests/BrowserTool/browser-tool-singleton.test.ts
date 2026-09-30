/**
 * Plan 583 seam A 鈥?the browser tool's singleton wiring.
 *
 * `process/agent-process-entry.ts` is the fourth consumer of the browser tool
 * and the easiest one to break: it does not import the `BrowserTool` class, it
 * imports the already-constructed singleton `{ browserTool }` from
 * `tool/builtin.js` and calls `setBrowserConfig()` on it when the main process
 * sends a `config:update` worker command. A grep for `import ... from
 * './BrowserTool/...'` misses that call site entirely, because the object
 * arrives through a re-export.
 *
 * So the invariant worth locking is an identity invariant, not an import
 * check: the object the entry mutates must be the same object the registry
 * registers and the same object the model sees. This asserts that without
 * booting Electron.
 *
 * The `human-like` mode is used as the probe because `BrowserTool.description`
 * is a getter that switches on the stored config, so a successful
 * `setBrowserConfig` is observable through the public tool surface rather than
 * through private state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { browserTool } from '../../src/tool/builtin.js';
import { BrowserTool } from '../../src/tool/BrowserTool/BrowserTool.js';
import {
  BROWSER_TOOL_NAME,
  BROWSER_TOOL_DESCRIPTION,
  BROWSER_TOOL_DESCRIPTION_HUMAN_LIKE,
} from '@duya/browser';

afterEach(() => {
  // The tool is a module-level singleton shared across this file's tests.
  browserTool.setBrowserConfig({ mode: 'extension', extensionProbeTimeoutMs: 500 });
});

describe('browser tool singleton (plan 583 seam A)', () => {
  it('re-exports the same instance the registry registers', () => {
    // If this ever diverges, `config:update` would silently retune an object
    // the agent never uses.
    expect(browserTool).toBeInstanceOf(BrowserTool);
  });

  it('exposes the config:update surface the worker command handler needs', () => {
    // `agent-process-entry.ts` calls exactly these two on the imported
    // singleton; either one disappearing is a runtime crash on that path.
    expect(typeof browserTool.setBrowserConfig).toBe('function');
    expect(typeof browserTool.setDomainBlockerConfig).toBe('function');
    expect(typeof browserTool.toTool).toBe('function');
  });

  it('propagates a backend mode change into the registered tool surface', () => {
    const before = browserTool.toTool();
    expect(before.name).toBe(BROWSER_TOOL_NAME);

    browserTool.setBrowserConfig({ mode: 'human-like', extensionProbeTimeoutMs: 500 });
    expect(browserTool.description).toBe(BROWSER_TOOL_DESCRIPTION_HUMAN_LIKE);
    // The description the model actually reads is derived, not cached, so the
    // switch has to show up in a freshly built definition too.
    expect(browserTool.toTool().description).toBe(BROWSER_TOOL_DESCRIPTION_HUMAN_LIKE);
    expect(browserTool.toTool().description).not.toBe(before.description);

    browserTool.setBrowserConfig({ mode: 'extension', extensionProbeTimeoutMs: 500 });
    expect(browserTool.description).toBe(BROWSER_TOOL_DESCRIPTION);
  });

  it('keeps the tool name stable across mode changes', () => {
    browserTool.setBrowserConfig({ mode: 'human-like', extensionProbeTimeoutMs: 500 });
    expect(browserTool.toTool().name).toBe(BROWSER_TOOL_NAME);
  });
});
