/**
 * os-context/fragment.ts — unit tests.
 *
 * Covers: renderSnapshot YAML-ish output, OSContextUserFragment marker
 * wrapping, body() truncation preserving head + tail, matchesText
 * dedup, role / contentKind immutability.
 *
 * Plan 453 Task C2.
 */

import { describe, it, expect } from 'vitest';

import {
  OSContextUserFragment,
  OS_CONTEXT_FRAGMENT_TOKEN_BUDGET,
  renderSnapshot,
  truncate,
  truncateMiddleWithTokenBudget,
} from '../fragment.js';
import { renderFragment } from '../../contextual-user-fragment.js';
import type { OSContext } from '../types.js';

const SAMPLE: OSContext = {
  schemaVersion: '0.4.0',
  capturedAt: '2026-08-28T00:00:00.000Z',
  focusedEntity: {
    kind: 'Document',
    confidence: 0.95,
    properties: {
      title: 'GitHub - duya',
      text: 'A long body of text representing the visible content of the page'.repeat(20),
      selectedText: 'selected snippet',
    },
    capabilities: { canRead: true, canWrite: false, canInvoke: false },
    source: 'uia',
  },
  intentCandidate: {
    intent: 'research',
    confidence: 0.85,
    evidence: ['chrome.exe', 'github.com'],
    requiredCapabilities: { canRead: true, canWrite: false, canInvoke: false },
    app: { pid: 1234, exeName: 'chrome.exe', appKind: 'browser' },
    source: 'rule',
  },
  interactionTrail: Array.from({ length: 30 }, (_, i) => ({
    ts: 1700000000000 + i * 100,
    type: 'window_focus' as const,
    app: { pid: 1234, exeName: 'chrome.exe' },
    window: {
      hwnd: '0xCAFE',
      title: `Window ${i}`,
      processName: 'chrome.exe',
      pid: 1234,
    },
    source: 'uia' as const,
  })),
  foreground: {
    pid: 1234,
    exeName: 'chrome.exe',
    title: 'GitHub - duya',
  },
  redacted: false,
  redactionReason: null,
};

describe('renderSnapshot', () => {
  it('renders a YAML-ish block with key fields', () => {
    const out = renderSnapshot(SAMPLE);
    expect(out).toContain('schemaVersion: 0.4.0');
    expect(out).toContain('capturedAt:');
    expect(out).toContain('foreground:');
    expect(out).toContain('exeName: chrome.exe');
    expect(out).toContain('focusedEntity:');
    expect(out).toContain('kind: Document');
    expect(out).toContain('intentCandidate:');
    expect(out).toContain('intent: research');
    expect(out).toContain('interactionTrail:');
  });

  it('renders focusedEntity: null when missing', () => {
    const out = renderSnapshot({ ...SAMPLE, focusedEntity: null });
    expect(out).toContain('focusedEntity: null');
  });

  it('renders intentCandidate: null when missing', () => {
    const out = renderSnapshot({ ...SAMPLE, intentCandidate: null });
    expect(out).toContain('intentCandidate: null');
  });

  it('renders redaction block when redacted', () => {
    const out = renderSnapshot({
      ...SAMPLE,
      redacted: true,
      redactionReason: 'password-manager-foreground',
    });
    expect(out).toContain('redaction:');
    expect(out).toContain('reason: password-manager-foreground');
  });

  it('emits empty interactionTrail gracefully', () => {
    const out = renderSnapshot({ ...SAMPLE, interactionTrail: [] });
    expect(out).toContain('interactionTrail:');
  });
});

describe('truncate', () => {
  it('returns the original when under the cap', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds an ellipsis indicator when over the cap', () => {
    const r = truncate('hello world', 6);
    expect(r.length).toBeLessThanOrEqual(6);
    expect(r.endsWith('\u2026')).toBe(true);
  });

  it('handles very small caps without crashing', () => {
    expect(truncate('hello', 2)).toBe('he');
  });
});

describe('truncateMiddleWithTokenBudget', () => {
  it('returns the original when under budget', () => {
    const text = 'small text';
    expect(truncateMiddleWithTokenBudget(text, 100)).toBe(text);
  });

  it('middle-truncates large text preserving head + tail', () => {
    const long = 'A'.repeat(100) + 'B'.repeat(1000) + 'C'.repeat(100);
    const r = truncateMiddleWithTokenBudget(long, 50); // budget ≈ 200 chars
    expect(r).toContain('A'.repeat(50));
    expect(r).toContain('C'.repeat(50));
    expect(r).toContain('omitted');
    expect(r.length).toBeLessThan(long.length);
  });

  it('respects the token budget (1800 default for OS context)', () => {
    const huge = 'X'.repeat(OS_CONTEXT_FRAGMENT_TOKEN_BUDGET * 8);
    const r = truncateMiddleWithTokenBudget(huge, OS_CONTEXT_FRAGMENT_TOKEN_BUDGET);
    // Cap is ~7200 chars; output should be smaller.
    expect(r.length).toBeLessThanOrEqual(OS_CONTEXT_FRAGMENT_TOKEN_BUDGET * APPROX + 64);
  });
});

const APPROX = 4; // mirror APPROX_CHARS_PER_TOKEN

describe('OSContextUserFragment', () => {
  it('declares role=user', () => {
    const f = new OSContextUserFragment(SAMPLE);
    expect(f.role()).toBe('user');
  });

  it('uses the os_context content kind', () => {
    const f = new OSContextUserFragment(SAMPLE);
    expect(f.contentKind()).toBe('os_context');
  });

  it('wraps body in <external_os_context> markers', () => {
    const f = new OSContextUserFragment(SAMPLE);
    expect(f.markers()).toEqual([
      '<external_os_context>',
      '</external_os_context>',
    ]);
    expect(f.body()).toContain('schemaVersion:');
  });

  it('renderFragment wraps body in markers', () => {
    const f = new OSContextUserFragment(SAMPLE);
    const block = renderFragment(f);
    expect(block.text).toContain('<external_os_context>');
    expect(block.text).toContain('</external_os_context>');
  });

  it('matchesText detects a duplicate body', () => {
    const f = new OSContextUserFragment(SAMPLE);
    expect(f.matchesText('foo <external_os_context> x </external_os_context> bar')).toBe(true);
    expect(f.matchesText('just plain text')).toBe(false);
  });
});