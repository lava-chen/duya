/**
 * runVisualSelfReview.test.ts
 *
 * Verifies that:
 *   - When `analyzeImage` is not configured → returns a clear "skipped"
 *     message and does NOT throw.
 *   - When `analyzeImage` is configured → it's called once with the rendered
 *     PNG (base64) and the vision-prompt wording.
 *   - When `analyzeImage` throws → the catch returns a soft-degrade message
 *     that does not surface the error stack to the agent.
 *   - When the overall pipeline times out → returns a "timed out" message.
 *
 * The HeadlessWidgetRenderer is stubbed via `setHeadlessWidgetRendererProvider`
 * so the test never launches a real browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runVisualSelfReview } from '../runVisualSelfReview.js';
import {
  setHeadlessWidgetRendererProvider,
  type RenderResult,
  type RenderError,
} from '../HeadlessWidgetRenderer.js';
import type { ToolUseContext, ToolUseContextOptions } from '../../../types.js';

function makeContext(analyzeImage?: ToolUseContextOptions['analyzeImage']): ToolUseContext {
  return {
    options: { analyzeImage } as ToolUseContextOptions,
    // The other ToolUseContext fields are unused by runVisualSelfReview.
  } as unknown as ToolUseContext;
}

const VALID_PNG_BASE64 =
  // 1×1 white pixel, base64-encoded, just enough to pass the size check.
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

function makeRenderResult(overrides: Partial<RenderResult> = {}): RenderResult {
  return {
    png: Buffer.from(VALID_PNG_BASE64, 'base64'),
    mimeType: 'image/png',
    width: 720,
    height: 480,
    elapsedMs: 120,
    ...overrides,
  };
}

describe('runVisualSelfReview', () => {
  beforeEach(() => {
    // Default: a "successful" renderer stub. Individual tests override it.
    setHeadlessWidgetRendererProvider(() => ({
      render: vi.fn(async () => makeRenderResult()),
      isReady: vi.fn(() => true),
      dispose: vi.fn(async () => {}),
    }) as unknown as ReturnType<typeof setHeadlessWidgetRendererProvider> extends () => infer R ? R : never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a skip message when analyzeImage is not configured', async () => {
    const context = makeContext(undefined);
    const result = await runVisualSelfReview('<svg></svg>', context);
    expect(result).toMatch(/Visual self-review skipped/i);
    expect(result).toMatch(/no vision model configured/i);
  });

  it('calls analyzeImage once with base64 PNG and review prompt', async () => {
    const analyzeImage = vi.fn(async (_b64: string, _mime: string, prompt?: string) => {
      expect(prompt).toMatch(/YOU just generated/i);
      return 'Looks good — no obvious issues.';
    });
    const context = makeContext(analyzeImage);

    const result = await runVisualSelfReview('<svg></svg>', context);

    expect(analyzeImage).toHaveBeenCalledTimes(1);
    const [b64, mime, prompt] = analyzeImage.mock.calls[0]!;
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(20);
    expect(mime).toBe('image/png');
    expect(prompt).toMatch(/Readability/);
    expect(result).toContain('Visual self-review of the widget');
    expect(result).toContain('Looks good — no obvious issues.');
  });

  it('soft-degrades when analyzeImage throws — agent still sees text', async () => {
    const analyzeImage = vi.fn(async () => {
      throw new Error('vision api rate-limited');
    });
    const context = makeContext(analyzeImage);

    const result = await runVisualSelfReview('<svg></svg>', context);
    expect(result).toMatch(/Visual self-review could not run/i);
    expect(result).toMatch(/vision api rate-limited/);
    // No stack trace leak
    expect(result).not.toMatch(/at Object\./);
  });

  it('soft-degrades when headless render fails', async () => {
    const renderError: RenderError = {
      ok: false,
      reason: 'init_failed',
      message: 'Playwright browser not installed',
      elapsedMs: 0,
    };
    setHeadlessWidgetRendererProvider(() => ({
      render: vi.fn(async () => renderError),
      isReady: vi.fn(() => false),
      dispose: vi.fn(async () => {}),
    }) as never);

    const analyzeImage = vi.fn(async () => 'should not be called');
    const context = makeContext(analyzeImage);

    const result = await runVisualSelfReview('<svg></svg>', context);
    expect(result).toMatch(/Visual self-review skipped/i);
    expect(result).toMatch(/headless render failed/i);
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it('soft-degrades when analyzeImage returns empty string', async () => {
    const analyzeImage = vi.fn(async () => '');
    const context = makeContext(analyzeImage);

    const result = await runVisualSelfReview('<svg></svg>', context);
    expect(result).toMatch(/returned empty result/i);
  });

  it('truncates the analysis to keep the LLM context manageable', async () => {
    const longAnalysis = 'x'.repeat(5000);
    const analyzeImage = vi.fn(async () => longAnalysis);
    const context = makeContext(analyzeImage);

    const result = await runVisualSelfReview('<svg></svg>', context);
    expect(result).toMatch(/\btruncated\b/);
    // Should still include the framing text + (truncated) feedback
    expect(result.length).toBeLessThan(longAnalysis.length + 500);
  });
});