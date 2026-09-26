/**
 * canvas_data_source tool (plan 570).
 *
 * Registers and manages named data sources for the bound canvas. A source is
 * periodically refreshed by the app's main process and its snapshot is pushed
 * live into workbench widgets:
 *   - http:       fetch a JSON endpoint (headers support "$env:NAME" refs)
 *   - project_db: query the canvas project's structured database
 *   - computed:   derive a snapshot from other sources via sandboxed code
 *
 * Refreshed snapshots are keyed by source name for computed sources and
 * widgets; the agent reads live values via action=refresh (returns the
 * snapshot) or action=list.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_data_source';

type DataSourceAction = 'register' | 'list' | 'update' | 'delete' | 'refresh';

const SOURCE_TYPES = ['http', 'project_db'] as const;

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Register and manage canvas DATA SOURCES for a workbench (plan: stock consoles, learning dashboards, project boards). ' +
    'A source is refreshed by the app (main process) on an interval or on demand, and its latest snapshot is pushed live into ' +
    'widget/dynamic elements — widgets never fetch the network themselves.\n' +
    '## Source types (config shape)\n' +
    '  - http:       { url, method?: "GET"|"POST", headers?: {name: value}, body?: string, path?: "dot.path.into.json" }. ' +
    'Header values may reference environment variables as "$env:NAME" — never inline credentials.\n' +
    '  - project_db: { command: {...} } — a project-database command; the canvas must be bound to a project folder.\n' +
    'Derived indicators and strategy logic do NOT belong here — embed them as JavaScript inside the widget/dynamic sourceCode ' +
    '(the workbench runtime passes them `window.duya.data` and executes them in the widget sandbox).\n' +
    '## Actions\n' +
    '  register: name + type + config (+ refreshIntervalSec, 0 = manual only, >= 15 for automatic).\n' +
    '  list:     all sources of the canvas (use to discover ids).\n' +
    '  update:   sourceId + fields to change (name/config/refreshIntervalSec/enabled).\n' +
    '  delete:   sourceId.\n' +
    '  refresh:  sourceId — refresh now; the response contains the latest snapshot, so prefer this over list to READ live data.\n' +
    'Typical flow: register one source per external feed (e.g. a stock quote endpoint), then build widget/dynamic elements ' +
    'whose markup and strategy scripts reference the sourceId. ' +
    'The canvasId is injected automatically — never pass it.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['register', 'list', 'update', 'delete', 'refresh'],
        description: 'Data source operation.',
      },
      name: { type: 'string', description: 'For register: unique source name on this canvas (1-64 chars), e.g. "stock-quote".' },
      type: { type: 'string', enum: SOURCE_TYPES, description: 'For register: source type.' },
      config: {
        type: 'object',
        description: 'For register/update: type-specific config (see the source-type table in the description).',
        additionalProperties: true,
      },
      refreshIntervalSec: { type: 'number', description: 'For register/update: 0 = manual only; >= 15 enables automatic refresh.' },
      enabled: { type: 'boolean', description: 'For update: enable/disable the source.' },
      sourceId: { type: 'string', description: 'For update/delete/refresh: the data source id (from list).' },
    },
    required: ['action'],
  },
};

function errorResult(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: TOOL_NAME,
    result: JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message } }),
    error: true,
  };
}

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) return noContextResult(TOOL_NAME);

    const action = input.action as DataSourceAction;
    if (!['register', 'list', 'update', 'delete', 'refresh'].includes(action)) {
      return errorResult(`action must be one of: register, list, update, delete, refresh`);
    }

    const optionalString = (key: string): string | null => {
      const value = input[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };

    const payload: Record<string, unknown> = { operation: action };

    if (action === 'register') {
      let canvasId: string;
      try {
        canvasId = getCanvasId(context);
      } catch {
        return noCanvasIdResult(TOOL_NAME);
      }
      const name = optionalString('name');
      const type = optionalString('type');
      if (!name) return errorResult('name is required for register');
      if (!type || !(SOURCE_TYPES as readonly string[]).includes(type)) {
        return errorResult(`type must be one of: ${SOURCE_TYPES.join(', ')}`);
      }
      if (!input.config || typeof input.config !== 'object') {
        return errorResult('config is required for register');
      }
      payload.canvasId = canvasId;
      payload.name = name;
      payload.type = type;
      payload.config = input.config;
      if (typeof input.refreshIntervalSec === 'number') {
        payload.refreshIntervalSec = input.refreshIntervalSec;
      }
    } else if (action === 'list') {
      let canvasId: string;
      try {
        canvasId = getCanvasId(context);
      } catch {
        return noCanvasIdResult(TOOL_NAME);
      }
      payload.canvasId = canvasId;
    } else {
      // update / delete / refresh are sourceId-addressed.
      const sourceId = optionalString('sourceId');
      if (!sourceId) return errorResult(`sourceId is required for ${action}`);
      payload.sourceId = sourceId;
      if (action === 'update') {
        if (input.name !== undefined) payload.name = input.name;
        if (input.config !== undefined) payload.config = input.config;
        if (input.refreshIntervalSec !== undefined) payload.refreshIntervalSec = input.refreshIntervalSec;
        if (input.enabled !== undefined) payload.enabled = input.enabled;
      }
    }

    const response = await ipcRequest<{ sourceId?: string; snapshot?: unknown; sources?: unknown[]; handlers?: unknown[] }>(
      context,
      action === 'refresh' ? 'data_source.refresh' : 'data_source.manage',
      payload,
      { retries: 0 },
    );

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
