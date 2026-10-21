/**
 * Loads design specification modules before generating visual output.
 *
 * Module READMEs are inlined from this package's resources by
 * `scripts/inline-modules.mjs`, so the content travels with every consumer
 * bundle and does not depend on a package-relative runtime filesystem path.
 */

import { BaseTool } from '../BaseTool.js';
import type { ToolExecutor, ToolResult } from '../contracts/tool.js';
import {
  INLINE_CHART,
  INLINE_DIAGRAM,
  INLINE_INTERACTIVE,
  INLINE_MOCKUP,
} from './inline-content.js';

export const MODULE_TOOL_NAME = 'read_module';

const MODULE_TOOL_DESCRIPTION = `Load design specification modules before generating visual output.

## When to use
Call read_module BEFORE using \`show_widget\` to load the design specification for your task. Choose the module that matches your rendering approach:
- **diagram** — SVG flowcharts, architecture diagrams, structure charts, sequence diagrams
- **mockup** — HTML cards, dashboards, comparison tables, data displays, key-value summaries
- **chart** — Data visualizations (Chart.js, D3, ApexCharts): bar/line/pie/scatter charts
- **interactive** — Interactive widgets with controls, calculators, converters, mini-apps

## How to choose
Decide based on what you are rendering, not what the data represents:
- "draw the system architecture" → diagram
- "show me sprint metrics as a dashboard" → mockup (or mockup + chart for dashboard with charts)
- "plot monthly active users" → chart
- "build a BMI calculator" → interactive
- "dashboard with charts" → pass ["mockup", "chart"] to load both

## Rules
- Call read_module ONCE per conversation for each paradigm you need
- You can load multiple modules at once by passing an array, e.g. ["diagram", "chart"]
- This is YOUR decision — no automatic hook or middleware triggers it
- Module content is authoritative for visual output style and constraints`;

const ALLOWED_MODULES = ['diagram', 'mockup', 'chart', 'interactive'] as const;
type ModuleName = (typeof ALLOWED_MODULES)[number];

const INLINE_MODULES: Record<ModuleName, string> = {
  diagram: INLINE_DIAGRAM,
  mockup: INLINE_MOCKUP,
  chart: INLINE_CHART,
  interactive: INLINE_INTERACTIVE,
};

const MODULE_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    module: {
      oneOf: [
        {
          type: 'string',
          enum: ALLOWED_MODULES,
        },
        {
          type: 'array',
          items: { type: 'string', enum: ALLOWED_MODULES },
          minItems: 1,
          maxItems: 4,
        },
      ],
      description:
        'Module name(s) to load. Single string or array. Available: diagram, mockup, chart, interactive.',
    },
  },
  required: ['module'],
};

const MODULE_NAME_PATTERN = /^[a-z0-9-]+$/;

function normalizeModuleNames(input: unknown): ModuleName[] {
  if (typeof input === 'string') {
    if ((ALLOWED_MODULES as readonly string[]).includes(input)) {
      return [input as ModuleName];
    }
    return [];
  }
  if (Array.isArray(input)) {
    const result: ModuleName[] = [];
    for (const item of input) {
      if (typeof item === 'string' && (ALLOWED_MODULES as readonly string[]).includes(item)) {
        result.push(item as ModuleName);
      }
    }
    return result;
  }
  return [];
}

export class ModuleTool extends BaseTool implements ToolExecutor {
  readonly name = MODULE_TOOL_NAME;
  readonly description = MODULE_TOOL_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = MODULE_TOOL_INPUT_SCHEMA;

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const moduleNames = normalizeModuleNames(input.module);

    if (moduleNames.length === 0) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: 'No valid module specified. Pass a module name string or array of names.',
          availableModules: ALLOWED_MODULES,
        }),
        error: true,
      };
    }

    const invalidNames = moduleNames.filter(
      (name) => !MODULE_NAME_PATTERN.test(name) || !ALLOWED_MODULES.includes(name),
    );

    if (invalidNames.length > 0) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Invalid module name(s): ${invalidNames.join(', ')}. Allowed characters: lowercase letters, digits, hyphens.`,
          availableModules: ALLOWED_MODULES,
        }),
        error: true,
      };
    }

    const results: string[] = [];
    const errors: string[] = [];

    for (const moduleName of moduleNames) {
      const content = INLINE_MODULES[moduleName];
      if (content && content.length > 0) {
        results.push(content);
      } else {
        errors.push(`"${moduleName}": inline content is empty (module is registered but not yet authored)`);
      }
    }

    if (errors.length > 0 && results.length === 0) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Failed to read all modules: ${errors.join('; ')}`,
          loadedModules: [],
          failedModules: moduleNames,
        }),
        error: true,
      };
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: results.join('\n\n---\n\n'),
      error: errors.length > 0 ? true : undefined,
    };
  }
}

export const moduleTool = new ModuleTool();
