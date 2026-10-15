/**
 * WidgetRenderer — visual self-review support for `show_widget`.
 *
 * Public surface:
 *   - `HeadlessWidgetRenderer`: low-level render-to-PNG service
 *   - `runVisualSelfReview`: high-level "render + vision critique" pipeline
 *   - `widgetRendererProvider` / `setHeadlessWidgetRendererProvider`:
 *     injection points for tests and process-level lifecycle.
 *
 * Lifecycle: callers are responsible for calling
 * `disposeHeadlessWidgetRenderer()` when the agent process shuts down so the
 * persistent chromium instance is freed.
 */

export {
  HeadlessWidgetRenderer,
  getHeadlessWidgetRenderer,
  disposeHeadlessWidgetRenderer,
  setHeadlessWidgetRendererProvider,
  widgetRendererProvider,
} from './HeadlessWidgetRenderer.js';
export type {
  RenderOptions,
  RenderResult,
  RenderError,
} from './HeadlessWidgetRenderer.js';

export { runVisualSelfReview } from './runVisualSelfReview.js';
export type { VisualSelfReviewOptions } from './runVisualSelfReview.js';
