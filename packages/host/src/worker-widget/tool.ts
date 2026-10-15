import { WidgetTool as CapabilityWidgetTool, WIDGET_TOOL_NAME } from '@duya/capabilities/widget-tool';
import type { WidgetReviewPort } from '@duya/capabilities/widget-tool';
import { runVisualSelfReview } from './runVisualSelfReview.js';
import type { WidgetReviewContext } from './runVisualSelfReview.js';
export { WIDGET_TOOL_NAME };
export class WidgetTool extends CapabilityWidgetTool<WidgetReviewContext> {
  constructor(reviewer: WidgetReviewPort<WidgetReviewContext> = { review: runVisualSelfReview }) { super(reviewer); }
}
export const widgetTool = new WidgetTool();
