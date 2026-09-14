/**
 * WidgetTool - Renders generative React widgets in the chat UI.
 *
 * Creates transient HTML widgets (charts, diagrams, calculators, mini-apps)
 * that are visible for the current chat turn only.
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import type { ToolUseContext } from '../../types.js';
import { runVisualSelfReview } from '../WidgetRenderer/runVisualSelfReview.js';

export const WIDGET_TOOL_NAME = 'show_widget';

const DESCRIPTION =
  'Renders a generative React widget (chart, diagram, calculator, mini-app) in the chat UI. ' +
  'Transient — only visible for the current chat turn. Use when static text or image is insufficient.';

export class WidgetTool implements Tool, ToolExecutor {
  readonly name = WIDGET_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      widget_code: {
        type: 'string',
        description:
          'Raw HTML/SVG/JS content. For SVG diagrams, use injected CSS classes as defined in the design ' +
          'specs (load via read_module). Output order: <style> → content HTML → <script>. For images, ' +
          'use https: or data: URLs only — local file paths are blocked by the widget CSP.',
      },
    },
    required: ['widget_code'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _wd?: string,
    context?: ToolUseContext
  ): Promise<ToolResult> {
    const widgetCode = input.widget_code as string;
    const reviewPromise = runVisualSelfReview(widgetCode ?? '', context);

    const safePromise = reviewPromise.then(
      (text) => ({ result: text, is_error: false }),
      (err: unknown) => ({
        result: `Widget self-review failed: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      })
    );

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({ widget_code: widgetCode }),
      pendingExtraResult: safePromise,
    };
  }
}

// Singleton instance for use in registries
export const widgetTool = new WidgetTool();
