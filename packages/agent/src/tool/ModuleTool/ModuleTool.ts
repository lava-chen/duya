import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

const MODULE_TOOL_NAME = 'read_module';

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

function getModulesDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    resolve(__dirname, '..', '..', 'src', 'modules'),
    resolve(__dirname, '..', '..', 'modules'),
    resolve(process.cwd(), 'packages', 'agent', 'src', 'modules'),
    resolve(process.cwd(), 'src', 'modules'),
    resolve(process.cwd(), 'modules'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

let _modulesDir: string | null = null;

function resolveModulePath(moduleName: string): string {
  if (_modulesDir === null) {
    _modulesDir = getModulesDir();
  }
  return join(_modulesDir, moduleName, 'README.md');
}

function normalizeModuleNames(input: unknown): ModuleName[] {
  if (typeof input === 'string') {
    return [input] as ModuleName[];
  }
  if (Array.isArray(input)) {
    return input as ModuleName[];
  }
  return [];
}

export class ModuleTool implements Tool, ToolExecutor {
  readonly name = MODULE_TOOL_NAME;
  readonly description = MODULE_TOOL_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = MODULE_TOOL_INPUT_SCHEMA;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const moduleInput = input.module;
    const moduleNames = normalizeModuleNames(moduleInput);

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
      try {
        const filePath = resolveModulePath(moduleName);
        const content = await readFile(filePath, 'utf-8');
        results.push(content);
      } catch (error) {
        errors.push(`"${moduleName}": ${(error as Error).message}`);
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

    const allContent = results.join('\n\n---\n\n');

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: allContent,
      error: errors.length > 0 ? true : undefined,
    };
  }
}

export const moduleTool = new ModuleTool();