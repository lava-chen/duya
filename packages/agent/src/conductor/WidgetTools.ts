import type { ConductorSnapshot } from './ConductorProfile.js';

export interface WidgetToolSchema {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface WidgetToolResult {
  success: boolean;
  result_patch?: Record<string, unknown>;
  action_id?: number;
  warning?: string;
  error?: string;
}

export const WIDGET_TOOL_SCHEMAS: WidgetToolSchema[] = [
  {
    name: 'conductor_get_snapshot',
    description: 'Read the current canvas snapshot including all widgets and their data',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
      },
      required: ['canvasId'],
    },
  },
  {
    name: 'conductor_update_widget_data',
    description: 'Update the data of a specific widget. Data is merged, not replaced.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        widgetId: { type: 'string', description: 'The widget ID to update' },
        canvasId: { type: 'string', description: 'The canvas ID' },
        data: { type: 'object', description: 'The data to merge into the widget' },
      },
      required: ['widgetId', 'canvasId', 'data'],
    },
  },
  {
    name: 'conductor_suggest_widget',
    description: 'Suggest adding a new widget to the canvas. Creates a suggestion, not a widget.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
        type: { type: 'string', description: 'Widget type (e.g., task-list, note-pad, pomodoro)' },
        reason: { type: 'string', description: 'Why this widget is suggested' },
        initialData: { type: 'object', description: 'Optional initial data for the widget' },
      },
      required: ['canvasId', 'type', 'reason'],
    },
  },
  {
    name: 'conductor_create_widget',
    description: 'Create a new widget on the canvas. Requires user confirmation.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
        type: { type: 'string', description: 'Widget type (e.g., task-list, note-pad, pomodoro)' },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
        },
        config: { type: 'object', description: 'Optional widget configuration' },
        data: { type: 'object', description: 'Optional initial widget data' },
      },
      required: ['canvasId', 'type', 'position'],
    },
  },
  {
    name: 'conductor_move_widget',
    description: 'Move a widget to a new position on the canvas. Requires user confirmation.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        widgetId: { type: 'string', description: 'The widget ID to move' },
        canvasId: { type: 'string', description: 'The canvas ID' },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
        },
      },
      required: ['widgetId', 'canvasId', 'position'],
    },
  },
  {
    name: 'conductor_delete_widget',
    description: 'Delete a widget from the canvas. Requires user confirmation and is reversible.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        widgetId: { type: 'string', description: 'The widget ID to delete' },
        canvasId: { type: 'string', description: 'The canvas ID' },
      },
      required: ['widgetId', 'canvasId'],
    },
  },
  {
    name: 'conductor_auto_layout',
    description: 'Automatically arrange widgets on the canvas. Shows preview before applying.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
        strategy: {
          type: 'string',
          enum: ['grid', 'compact', 'columns'],
          description: 'Layout strategy to use',
        },
      },
      required: ['canvasId'],
    },
  },
];

export function getWidgetToolSchemas(snapshot: ConductorSnapshot): WidgetToolSchema[] {
  return WIDGET_TOOL_SCHEMAS;
}

export function formatToolSchemasForPrompt(schemas: WidgetToolSchema[]): string {
  return schemas.map((tool) => {
    const props = Object.entries(tool.inputSchema.properties)
      .map(([key, schema]) => {
        const desc = (schema as Record<string, unknown>).description || '';
        const required = tool.inputSchema.required?.includes(key) ? ' (required)' : '';
        return `    - ${key}: ${desc}${required}`;
      })
      .join('\n');

    return `### ${tool.name} [Risk: ${tool.risk}]
${tool.description}
  Parameters:
${props}`;
  }).join('\n\n');
}
