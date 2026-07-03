/**
 * runVisualSelfReview
 *
 * Async post-execution hook for the `show_widget` tool. After the agent
 * submits a widget, we render it headlessly and ask the configured vision
 * model to give a text critique. The result is appended as a synthetic
 * tool_result so the agent can decide whether to iterate.
 *
 * Behavior contract (per Plan D4: failure soft-degrades — never throws to
 * the caller). All outcomes are returned as a human-readable string the
 * agent can act on or ignore. The function never modifies DB or SSE state
 * itself; the caller wires the result into the tool_result channel.
 */

import type { ToolUseContext } from '../../types.js';
import { widgetRendererProvider } from './HeadlessWidgetRenderer.js';
import { logger } from '../../utils/logger.js';

export interface VisualSelfReviewOptions {
  theme?: 'light' | 'dark';
  /**
   * Timeout for the whole visual review pipeline (render + vision call).
   * Defaults to 15000ms — chosen to fit inside one LLM "wait" heartbeat
   * without making the chat feel hung if vision is slow.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 15_000;

/**
 * The review prompt explicitly tells the model it is the agent itself, not
 * the user, performing the review. This avoids the "user is giving feedback"
 * misframing that some Claude / GPT variants fall into when asked to
 * critique a chart.
 */
const REVIEW_PROMPT = `You are reviewing a UI widget that YOU just generated as part of your own previous response in this conversation.
The widget is meant to convey specific information to the user via the chat. After this review, you (the assistant) will decide whether to iterate or proceed.

Please describe what you see and assess these axes concisely:
1. **Readability**: Is text readable? Any overflow, clipping, low contrast, or missing labels?
2. **Layout**: Are elements well-positioned? Any visual misalignment, overlap, or excessive whitespace?
3. **Completeness**: Does the visualization actually convey what it should, based on the surrounding conversation?
4. **Issues**: List any specific, actionable problems (e.g. "node X overlaps node Y", "legend is missing", "color contrast is too low on the subtitle line").

Keep the review under 200 words. If everything looks good, say "Looks good — no obvious issues." explicitly. Do NOT hedge or restate the prompt.`;

export async function runVisualSelfReview(
  widgetCode: string,
  context: ToolUseContext | undefined,
  options: VisualSelfReviewOptions = {},
): Promise<string> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;

  const analyzeImage = context?.options?.analyzeImage;
  if (typeof analyzeImage !== 'function') {
    // Same shape as VisionTool.ts:213 — agents without Vision configured
    // must see a clear, non-error message so they don't loop trying again.
    return 'Visual self-review skipped: no vision model configured in Settings > Vision Model. Proceed without self-review.';
  }

  // Run the whole pipeline under one timeout so a hung vision call can't pin
  // the tool_use outstanding forever.
  const work = (async () => {
    const renderer = widgetRendererProvider();
    const renderResult = await renderer.render(widgetCode, {
      theme: options.theme ?? 'dark',
      timeoutMs: Math.min(timeoutMs - 2000, 6000),
    });

    if (!('png' in renderResult)) {
      // RenderError shape: {ok:false, reason, message, elapsedMs}
      const reason = (renderResult as { reason?: string }).reason ?? 'unknown';
      const message = (renderResult as { message?: string }).message ?? 'unknown error';
      logger.warn('[widgetVisualReview] Headless render failed', { reason, message });
      return `Visual self-review skipped: headless render failed (${reason}). ${message}\nThe widget still displayed normally; continuing without self-review.`;
    }

    const { png, width, height, elapsedMs: renderMs } = renderResult;
    const base64 = png.toString('base64');

    let analysis: string;
    try {
      analysis = await analyzeImage(base64, 'image/png', REVIEW_PROMPT);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[widgetVisualReview] Vision analysis threw', { message });
      return `Visual self-review could not run: vision model error. ${message}\nHeadless render succeeded (${width}×${height} in ${renderMs}ms) but the configured vision model failed. The widget still displayed normally; continuing without self-review.`;
    }

    if (!analysis || analysis.trim().length === 0) {
      return `Visual self-review returned empty result from vision model. Headless render succeeded (${width}×${height} in ${renderMs}ms). Proceeding without self-review.`;
    }

    return formatReviewResult(analysis, { renderMs, width, height, totalMs: Date.now() - start });
  })();

  const result = await Promise.race([
    work,
    new Promise<string>((resolve) =>
      setTimeout(
        () =>
          resolve(
            `Visual self-review timed out after ${timeoutMs}ms. Headless render may have stalled. The widget still displayed normally; continuing without self-review.`,
          ),
        timeoutMs,
      ),
    ),
  ]);

  return result;
}

function formatReviewResult(
  analysis: string,
  meta: { renderMs: number; width: number; height: number; totalMs: number },
): string {
  // Trim analysis to avoid surprising the LLM with a wall of text.
  const trimmed = analysis.length > 1500 ? `${analysis.slice(0, 1500)}\n[…truncated]` : analysis;

  return [
    'Visual self-review of the widget you just rendered:',
    '',
    trimmed,
    '',
    `(rendered ${meta.width}×${meta.height} in ${meta.totalMs}ms — headless render ${meta.renderMs}ms, vision ~${meta.totalMs - meta.renderMs}ms)`,
  ].join('\n');
}
