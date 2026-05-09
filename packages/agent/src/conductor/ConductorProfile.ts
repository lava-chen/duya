/**
 * Conductor - DUYA agent profile for canvas workspace management.
 *
 * Conductor is NOT a separate agent. It is a PROFILE of duyaAgent:
 *   - Uses the existing agent loop (duyaAgent.streamChat)
 *   - Custom system prompt that describes the canvas + widget operations
 *   - Custom tools exported to the tool registry for LLM discovery
 *   - <action> tag execution handled on the renderer side via conductor:action IPC
 *
 * The agent-process-entry creates a standard duyaAgent with this profile
 * when the conductor session starts. No custom agent loop.
 */

import type { Tool, ToolResult, ToolUseContext } from '../types.js';
import type { ToolExecutor } from '../tool/registry.js';

export interface ConductorSnapshot {
  canvasId: string;
  canvasName: string;
  widgets: Array<{
    id: string;
    type: string;
    kind: string;
    position: { x: number; y: number; w: number; h: number };
    config: Record<string, unknown>;
    data: Record<string, unknown>;
    dataVersion: number;
  }>;
  actionCursor: number;
}

// ── Tool Definitions ────────────────────────────────────────────

export const CONDUCTOR_TOOLS: Tool[] = [
  {
    name: 'conductor_update_widget_data',
    description: 'Update the data of a widget on the canvas. Data is merged with existing data. Use this to add/modify tasks, news articles, notes, timer settings.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID (shown in system prompt)' },
        widgetId: { type: 'string', description: 'The target widget ID (shown in system prompt)' },
        data: { type: 'object', description: 'Full new data for the widget. For task-list: { tasks: [...] }. For news-board: { articles: [...], lastUpdated: "..." }. For note-pad: { content: "..." }. For pomodoro: { duration: N, currentTask: "..." }' },
      },
      required: ['canvasId', 'widgetId', 'data'],
    },
  },
  {
    name: 'conductor_create_widget',
    description: 'Create a new widget on the canvas. Use when the canvas lacks a needed widget type.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
        type: { type: 'string', description: 'Widget type: task-list, note-pad, pomodoro, news-board' },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            w: { type: 'number' }, h: { type: 'number' },
          },
          description: 'Grid position and size',
        },
        data: { type: 'object', description: 'Initial widget data (optional)' },
      },
      required: ['canvasId', 'type', 'position'],
    },
  },
  {
    name: 'conductor_get_snapshot',
    description: 'Get the current canvas state. Returns all widgets and their data. NOT a search tool - it reads from the canvas DB.',
    input_schema: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'The canvas ID' },
      },
      required: ['canvasId'],
    },
  },
];

// ── Tool Executors ───────────────────────────────────────────────

const updateWidgetDataExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const { canvasId, widgetId, data } = input;

    return {
      id: crypto.randomUUID(),
      name: 'conductor_update_widget_data',
      result: JSON.stringify({
        success: true,
        action: 'widget.update_data',
        canvasId,
        widgetId,
        data,
      }),
    };
  },
};

const createWidgetExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const { canvasId, type, position, data } = input;

    return {
      id: crypto.randomUUID(),
      name: 'conductor_create_widget',
      result: JSON.stringify({
        success: true,
        action: 'widget.create',
        canvasId,
        kind: 'builtin',
        type,
        position,
        data: data || {},
      }),
    };
  },
};

const getSnapshotExecutor: ToolExecutor = {
  async execute(
    _input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    return {
      id: crypto.randomUUID(),
      name: 'conductor_get_snapshot',
      result: JSON.stringify({
        success: true,
        note: 'Canvas state is provided in the system prompt. No additional DB query needed.',
      }),
    };
  },
};

// ── Registry Helpers ─────────────────────────────────────────────

export function getConductorToolExecutors(): Record<string, ToolExecutor> {
  return {
    conductor_update_widget_data: updateWidgetDataExecutor,
    conductor_create_widget: createWidgetExecutor,
    conductor_get_snapshot: getSnapshotExecutor,
  };
}
