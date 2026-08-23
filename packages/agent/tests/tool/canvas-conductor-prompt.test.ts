// packages/agent/tests/tool/canvas-conductor-prompt.test.ts
// Regression guard for the canvas chat-link contract: the conductor
// prompt must teach the canonical `[label](/duya/canvas/<canvasId>)`
// markdown form, because the renderer's MarkdownAnchor only recognizes
// that shape (see src/lib/chat-file-links.ts parseInternalCanvasLink).
// If the prompt drifts, models invent dead URL shapes (file paths,
// http links) that render as unclickable filesystem pills.

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
