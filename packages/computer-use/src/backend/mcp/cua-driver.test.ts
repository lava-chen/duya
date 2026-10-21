/**
 * cua-driver.test.ts — McpCuaDriverBackend over a mocked driver
 * (plan 519 §3.1 / D1). Verifies the tool-name mapping, result parsing,
 * and that an injected callTool avoids spawning any real process.
 */

import { describe, it, expect } from 'vitest';
import {
  McpCuaDriverBackend,
  CUA_TOOL_NAME,
  type CallTool,
  type McpToolResultContent,
} from './cua-driver.js';
import {
  parseCaptureResult,
  parseActionResult,
  parseListApps,
} from './result-parser.js';

/** Build a fake MCP tool call that returns the given text JSON payload. */
function fakeCallTool(payload: unknown, imageBase64?: string): CallTool {
  return async (_toolName: string, _input: Record<string, unknown>): Promise<McpToolResultContent> => {
    const content: Array<{ type: string; text?: string }> = [
      { type: 'text', text: JSON.stringify(payload ?? {}) },
    ];
    if (imageBase64) content.push({ type: 'image', text: imageBase64 });
    return { content };
  };
}

function makeBackend(call: CallTool): McpCuaDriverBackend {
  return new McpCuaDriverBackend({ callTool: call });
}

describe('McpCuaDriverBackend — protocol mapping', () => {
  it('routes capture to the MCP capture tool and parses base64 + elements', async () => {
    let calledWith: string | null = null;
    const backend = makeBackend(async (tool, _input) => {
      calledWith = tool;
      return {
        content: [
          { type: 'text', text: JSON.stringify({
            width: 1280,
            height: 720,
            displayId: 0,
            elements: [
              { index: 1, bbox: { x: 10, y: 20, w: 30, h: 40 }, label: 'Button', kind: 'Button', axSource: 'uia' },
            ],
          }) },
          { type: 'image', text: 'iVBORw0KGgo=', },
        ],
      };
    });
    const result = await backend.capture({ somMode: true });
    expect(calledWith).toBe(CUA_TOOL_NAME.capture);
    expect(result.base64).toBe('iVBORw0KGgo=');
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ index: 1, kind: 'Button', axSource: 'uia' });
  });

  it('click parses action result with verdict passthrough', async () => {
    const backend = makeBackend(fakeCallTool({
      ok: true,
      durationMs: 42,
      verdict: {
        effect: 'confirmed',
        verified: { elementChanged: true, newFocusedEntity: null },
      },
    }));
    const result = await backend.click({ element: 3 });
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBe(42);
    expect(result.verdict?.effect).toBe('confirmed');
    expect(result.verdict?.verified.elementChanged).toBe(true);
  });

  it('propagates fallbackUsed + escalation from the driver', async () => {
    const backend = makeBackend(fakeCallTool({
      ok: false,
      reason: 'uipi-blocked',
      verdict: {
        effect: 'unverifiable',
        fallbackUsed: true,
        escalation: { recommended: 'raise', reason: 'cross-window' },
      },
    }));
    const result = await backend.click({ x: 5, y: 6 });
    expect(result.ok).toBe(false);
    expect(result.verdict?.fallbackUsed).toBe(true);
    expect(result.verdict?.escalation?.recommended).toBe('raise');
  });

  it('listApps parses the app array', async () => {
    const backend = makeBackend(fakeCallTool({
      apps: [
        { title: 'Chrome', processName: 'chrome', pid: 100 },
      ],
    }));
    const apps = await backend.listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ title: 'Chrome', processName: 'chrome', pid: 100 });
  });

  it('wait tolerates a bare Ok payload', async () => {
    const backend = makeBackend(async () => ({ content: [] }));
    await expect(backend.wait({ ms: 10 })).resolves.toBeUndefined();
  });
});

describe('resolveCuaDriverCommand / factory selection', () => {
  it('platform win32 defaults to Electron (no MCP) unless env overrides', async () => {
    // Import is dynamic to avoid reading process.env at module scope.
    const factory = await import('../electron/factory.js');
    // Clean env around the assertion.
    const prev = process.env.DUYA_CUA_DRIVER;
    delete process.env.DUYA_CUA_DRIVER;
    try {
      expect(factory.shouldUseMcpDriver('win32')).toBe(false);
      expect(factory.shouldUseMcpDriver('darwin')).toBe(true);
      expect(factory.shouldUseMcpDriver('linux')).toBe(true);
    } finally {
      if (prev !== undefined) process.env.DUYA_CUA_DRIVER = prev;
    }
  });

  it('DUYA_CUA_DRIVER=external forces MCP on any platform', async () => {
    const factory = await import('../electron/factory.js');
    const prev = process.env.DUYA_CUA_DRIVER;
    process.env.DUYA_CUA_DRIVER = 'external';
    try {
      expect(factory.shouldUseMcpDriver('win32')).toBe(true);
      const driver = factory.resolveCuaDriverCommand();
      expect(driver?.command).toBe('cua-driver');
    } finally {
      if (prev === undefined) delete process.env.DUYA_CUA_DRIVER;
      else process.env.DUYA_CUA_DRIVER = prev;
    }
  });

  it('a bare env value is treated as a qualified launcher command', async () => {
    const factory = await import('../electron/factory.js');
    const prev = process.env.DUYA_CUA_DRIVER;
    process.env.DUYA_CUA_DRIVER = 'python -m cua_driver';
    try {
      const driver = factory.resolveCuaDriverCommand();
      expect(driver?.command).toBe('python');
      expect(driver?.args).toEqual(['-m', 'cua_driver']);
    } finally {
      if (prev === undefined) delete process.env.DUYA_CUA_DRIVER;
      else process.env.DUYA_CUA_DRIVER = prev;
    }
  });
});

describe('result-parser — cross-ABI robustness', () => {
  it('capture with a non-JSON text block still yields geometry', () => {
    const result: McpToolResultContent = { content: [{ type: 'text', text: 'not-json' }] };
    const parsed = parseCaptureResult(result);
    // No JSON payload, no image → empty but defined.
    expect(parsed.base64).toBe('');
    expect(parsed.elements).toEqual([]);
    expect(parsed.width).toBe(0);
  });

  it('click defaults ok=true on a success-shaped payload, ok=false with reason on failure', () => {
    expect(parseActionResult({ content: [{ type: 'text', text: '{"ok":true}' }] }).ok).toBe(true);
    const failing = parseActionResult({ content: [{ type: 'text', text: '{"ok":false,"reason":"nope"}' }] });
    expect(failing.ok).toBe(false);
    expect(failing.reason).toBe('nope');
  });
});