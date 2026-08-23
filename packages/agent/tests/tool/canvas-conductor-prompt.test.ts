// packages/agent/tests/tool/canvas-conductor-prompt.test.ts
// Regression guard for two prompt contracts:
//
// 1. Canvas chat links — the conductor prompt must teach the canonical
//    [label](/duya/canvas/<canvasId>) markdown form, because the renderer's
//    MarkdownAnchor only recognizes that shape (see src/lib/chat-file-links.ts
//    parseInternalCanvasLink). If the prompt drifts, models invent dead URL
//    shapes (file paths, http links) that render as unclickable pills.
// 2. Audience & reporting — the board is part of the answer for non-coding
//    users; verification is budgeted self-checking; internal mechanics
//    (UUIDs, coordinates, capture verdicts) never reach user-facing replies.
//    Session evidence 2026-08-23 showed layout-status narration replacing
//    actual answers without these anchors.

import { describe, it, expect } from 'vitest';
import { buildConductorPrompt } from '../../src/tool/CanvasConductor/prompt.js';

describe('buildConductorPrompt canvas link guidance', () => {
  it('teaches the /duya/canvas/<canvasId> markdown link format', () => {
    const prompt = buildConductorPrompt();
    expect(prompt).toContain('/duya/canvas/<canvasId>');
    expect(prompt).toContain('canvas_manage');
  });

  it('keeps the link section when widget style history is appended', () => {
    const prompt = buildConductorPrompt([
      { backgroundColor: '#fff', textColor: '#000', fontFamily: 'sans', layoutType: 'block' },
    ]);
    expect(prompt).toContain('/duya/canvas/<canvasId>');
    expect(prompt).toContain('Avoid Repetition for Mini Components');
  });
});

describe('buildConductorPrompt audience and reporting contract', () => {
  it('frames the canvas as part of the answer for non-coding users', () => {
    const prompt = buildConductorPrompt();
    expect(prompt).toContain('### Audience and Presentation');
    expect(prompt).toContain('most users do not write code');
    expect(prompt).toContain('Content outranks geometry');
  });

  it('budgets verification and forbids moving content for its own capture', () => {
    const prompt = buildConductorPrompt();
    expect(prompt).toContain('### Verifying Before You Report');
    expect(prompt).toContain('run at most one more only if that pass found a defect you then fixed');
    expect(prompt).toContain(
      'Never move, resize, or delete already-placed content just to make it visible inside your own capture',
    );
  });

  it('bans internal mechanics from user-facing replies', () => {
    const prompt = buildConductorPrompt();
    expect(prompt).toContain('### Reporting to the User');
    expect(prompt).toContain('Never show element UUIDs, grid ranges, or capture/vision verdicts');
    expect(prompt).toContain('Do not append spatial inventories');
  });
});
