/**
 * ax-helper-protocol.ts — unit tests (plan 572 Phase 0).
 *
 * Covers request serialization, response parsing (ready / heartbeat /
 * success / structured failure), AX-role → UIA ControlType mapping,
 * element descriptor conversion (incl. AXSecureField redaction and
 * handle pass-through), the mac browser vocabulary, and the
 * AppleScript dictionary table.
 */

import { describe, expect, it } from 'vitest';

import {
  axElementToDescriptor,
  axEnumeratedToDescriptor,
  axRoleToControlType,
  browserUrlAppleScript,
  buildAxRequestLine,
  DEFAULT_INTERACTIVE_AX_ROLES,
  isMacBrowserProcess,
  parseAxHelperLine,
} from '../ax-helper-protocol.js';

describe('request building', () => {
  it('serializes every op as one JSON line with the op discriminator', () => {
    expect(JSON.parse(buildAxRequestLine({ id: 1, op: 'ping' }))).toEqual({ id: 1, op: 'ping' });
    expect(JSON.parse(buildAxRequestLine({ id: 2, op: 'enumerate', pid: 42, maxNodes: 200 }))).toEqual({
      id: 2,
      op: 'enumerate',
      pid: 42,
      maxNodes: 200,
    });
    expect(JSON.parse(buildAxRequestLine({ id: 3, op: 'action', pid: 42, handle: 'h1', action: 'AXPress' }))).toEqual({
      id: 3,
      op: 'action',
      pid: 42,
      handle: 'h1',
      action: 'AXPress',
    });
    expect(JSON.parse(buildAxRequestLine({ id: 4, op: 'keyToPid', pid: 7, vk: 36, flags: ['cmd'] }))).toEqual({
      id: 4,
      op: 'keyToPid',
      pid: 7,
      vk: 36,
      flags: ['cmd'],
    });
  });
});

describe('response parsing', () => {
  it('parses the ready and heartbeat lines', () => {
    expect(parseAxHelperLine('{"ready":true}')).toEqual({ kind: 'ready' });
    expect(parseAxHelperLine('{"type":"heartbeat"}')).toEqual({ kind: 'heartbeat' });
  });

  it('parses a successful fg response', () => {
    const parsed = parseAxHelperLine(
      '{"id":3,"ok":true,"fg":{"windowId":6506,"pid":19560,"processName":"ZCode","title":"t"}}',
    );
    expect(parsed).toMatchObject({
      kind: 'response',
      id: 3,
      ok: true,
      data: { fg: { windowId: 6506, pid: 19560, processName: 'ZCode', title: 't' } },
    });
  });

  it('parses a structured failure with the error code', () => {
    const parsed = parseAxHelperLine(
      '{"id":2,"ok":false,"error":{"code":"permission-denied","message":"not trusted"}}',
    );
    expect(parsed).toMatchObject({
      kind: 'response',
      id: 2,
      ok: false,
      error: { code: 'permission-denied', message: 'not trusted' },
    });
  });

  it('parses an enumerate payload with elements and qualifiers', () => {
    const line =
      '{"id":5,"ok":true,"elements":[{"role":"AXButton","name":"Sign In","handle":"h9","rect":{"x":1,"y":2,"w":80,"h":24},"interactive":true}],"truncated":true,"reason":"empty-tree"}';
    const parsed = parseAxHelperLine(line);
    expect(parsed && parsed.kind === 'response' && parsed.ok).toBe(true);
    if (parsed && parsed.kind === 'response' && parsed.ok) {
      expect(parsed.data.elements).toHaveLength(1);
      expect(parsed.data.truncated).toBe(true);
      expect(parsed.data.reason).toBe('empty-tree');
    }
  });

  it('returns null for non-protocol lines', () => {
    expect(parseAxHelperLine('')).toBeNull();
    expect(parseAxHelperLine('not json')).toBeNull();
    expect(parseAxHelperLine('{"id":1}')).toBeNull();
    expect(parseAxHelperLine('{"id":1,"ok":true,"elements":[{"role":42}]}')).toBeNull();
  });
});

describe('AX role mapping', () => {
  it('maps the interactive roles to the UIA vocabulary', () => {
    expect(axRoleToControlType('AXButton')).toBe('Button');
    expect(axRoleToControlType('AXSecureField')).toBe('Edit');
    expect(axRoleToControlType('AXPopUpButton')).toBe('ComboBox');
    expect(axRoleToControlType('AXLink')).toBe('Hyperlink');
  });

  it('degrades unknown roles by stripping the AX prefix', () => {
    expect(axRoleToControlType('AXRuler')).toBe('Ruler');
    expect(axRoleToControlType(undefined)).toBe('Control');
  });

  it('keeps the whitelist free of container-only roles', () => {
    expect(DEFAULT_INTERACTIVE_AX_ROLES).toContain('AXButton');
    expect(DEFAULT_INTERACTIVE_AX_ROLES).not.toContain('AXGroup');
    expect(DEFAULT_INTERACTIVE_AX_ROLES).not.toContain('AXSplitGroup');
  });
});

describe('descriptor conversion', () => {
  it('stamps source ax-helper and carries the handle', () => {
    const d = axElementToDescriptor({
      role: 'AXButton',
      name: 'OK',
      handle: 'h3',
      rect: { x: 0, y: 0, w: 10, h: 10 },
    });
    expect(d).toMatchObject({ name: 'OK', controlType: 'Button', handle: 'h3', source: 'ax-helper' });
  });

  it('flags AXSecureField as a password field from the role alone', () => {
    const d = axEnumeratedToDescriptor({ role: 'AXSecureField', handle: 'h4' });
    expect(d).toMatchObject({ isPassword: true, controlType: 'Edit', source: 'ax-helper' });
  });

  it('decodes null and malformed payloads to source none', () => {
    expect(axElementToDescriptor(null)).toEqual({ source: 'none' });
    expect(axElementToDescriptor({ role: 42 })).toEqual({ source: 'none' });
  });

  it('returns null (not none) for malformed enumerate entries so callers drop rows', () => {
    expect(axEnumeratedToDescriptor({ role: 42 })).toBeNull();
  });
});

describe('mac browser vocabulary', () => {
  it('matches localized macOS browser names and Windows executable names', () => {
    expect(isMacBrowserProcess('Google Chrome')).toBe(true);
    expect(isMacBrowserProcess('safari')).toBe(true);
    expect(isMacBrowserProcess('Microsoft Edge')).toBe(true);
    expect(isMacBrowserProcess('Brave Browser')).toBe(true);
    expect(isMacBrowserProcess('chrome')).toBe(true);
    expect(isMacBrowserProcess('Finder')).toBe(false);
    expect(isMacBrowserProcess('WeChat')).toBe(false);
  });

  it('maps known browsers to AppleScript dictionaries and skips unknowns', () => {
    expect(browserUrlAppleScript('Safari')).toContain('URL of front document');
    expect(browserUrlAppleScript('Google Chrome')).toContain('URL of active tab of front window');
    expect(browserUrlAppleScript('Google Chrome')).toContain('"Google Chrome"');
    expect(browserUrlAppleScript('Finder')).toBeNull();
    expect(browserUrlAppleScript('')).toBeNull();
  });
});
