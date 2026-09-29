/**
 * Plan 580 Phase 4 — D8 result fidelity shared last-mile.
 *
 * `composeResultFromBlocks` is the ONLY place a non-text MCP content
 * block touches the model-visible text: one deterministic ≤200-char
 * metadata line. The canonical block rides losslessly in
 * `ToolResult.blocks`; the base64 payload NEVER enters the text.
 */

import { describe, it, expect } from 'vitest';
import { composeResultFromBlocks, describeNonTextBlock } from '../result-blocks.js';

describe('composeResultFromBlocks (plan 580 D8)', () => {
  it('joins text blocks verbatim', () => {
    const composed = composeResultFromBlocks([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    expect(composed.text).toBe('first\nsecond');
    expect(composed.hasNonText).toBe(false);
  });

  it('appends bounded metadata for non-text blocks and never the payload', () => {
    const base64 = 'A'.repeat(400_000); // ~300KB of payload
    const composed = composeResultFromBlocks([
      { type: 'text', text: 'here is your chart' },
      { type: 'image', mimeType: 'image/png', data: base64 },
    ]);
    expect(composed.hasNonText).toBe(true);
    expect(composed.text).toContain('here is your chart');
    expect(composed.text).toMatch(/\[image image\/png ~293KB #1\]/);
    // The payload itself must NEVER leak into the model-visible text.
    expect(composed.text).not.toContain('AAAA');
    expect(composed.text.length).toBeLessThan(300);
  });

  it('handles audio, resource, and resource_link deterministically', () => {
    const composed = composeResultFromBlocks([
      { type: 'audio', mimeType: 'audio/wav', data: 'B'.repeat(2048) },
      { type: 'resource', resource: { uri: 'file:///x.txt', mimeType: 'text/plain' } },
      { type: 'resource_link', uri: 'https://example.com/x' },
    ]);
    expect(composed.text).toBe(
      '[audio audio/wav ~2KB #0]\n[resource file:///x.txt text/plain #1]\n[resource_link https://example.com/x #2]',
    );
  });

  it('truncates any metadata line at 200 chars', () => {
    const line = describeNonTextBlock(
      { type: 'resource_link', uri: `https://example.com/${'x'.repeat(400)}` },
      0,
    );
    expect(line.length).toBe(200);
    expect(line.endsWith('...')).toBe(true);
  });

  it('tolerates non-object garbage blocks and non-array content', () => {
    expect(composeResultFromBlocks([null, 42, 'str']).text).toBe('[unknown block #0]\n[unknown block #1]\n[unknown block #2]');
    expect(composeResultFromBlocks(undefined)).toEqual({ text: '', hasNonText: false });
  });
});
