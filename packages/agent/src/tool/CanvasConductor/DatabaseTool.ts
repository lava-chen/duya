/**
 * database_manage tool.
 *
 * Structured access to the current canvas project's .duya/database.sqlite.
 * The Agent never receives a filesystem path and never opens SQLite itself.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'database_manage';

type DatabaseAction =
  | 'list_sources'
  | 'get_source'
  | 'create_source'
  | 'add_property'
  | 'create_record'
  | 'update_record'
  | 'archive_record'
  | 'create_view'
  | 'query';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Manage structured project databases stored in .duya/database.sqlite. A database source owns stable properties and records; ' +
    'saved views own filters, sorts, and layout. Use list_sources/get_source to discover stable IDs before mutations. ' +
    'Use create_source to create the data source, then canvas_create_element with kind native/database and config {sourceId,viewId,sourceTitle,displayMode:"embedded",showTitle:true,previewLimit:50,interactionMode:"canvas"} to place a view on the canvas. ' +
    'Record updates require expectedRevision and fail on stale data instead of overwriting user edits.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list_sources', 'get_source', 'create_source', 'add_property', 'create_record', 'update_record', 'archive_record', 'create_view', 'query'],
      },
      sourceId: { type: 'string', description: 'Stable source UUID. Required except for list_sources and create_source.' },
      viewId: { type: 'string', description: 'Stable saved-view UUID. Optional for query.' },
      recordId: { type: 'string', description: 'Stable record UUID for update/archive.' },
      name: { type: 'string', description: 'Source, property, or view name depending on action.' },
      description: { type: 'string', description: 'Optional source description.' },
      propertyType: {
        type: 'string',
        enum: ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url'],
      },
      options: {
        type: 'array',
        description: 'Stable select/status options created with the property.',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, color: { type: 'string' }, groupId: { type: 'string' } },
          required: ['name'],
        },
      },
      title: { type: 'string', description: 'Record title.' },
      values: {
        type: 'object',
        description: 'Property-ID keyed values. Select/status values are option IDs, not display names.',
        additionalProperties: true,
      },
      expectedRevision: { type: 'number', description: 'Required for update_record and archive_record.' },
      archived: { type: 'boolean', description: 'Archive or restore a record. Defaults to true.' },
      filter: { type: 'object', description: 'Validated filter AST using propertyId/operator/value.', additionalProperties: true },
      sorts: {
        type: 'array',
        items: {
          type: 'object',
          properties: { propertyId: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
          required: ['propertyId', 'direction'],
        },
      },
      layout: { type: 'object', description: 'Saved table-view layout configuration.', additionalProperties: true },
      limit: { type: 'number', minimum: 1, maximum: 500, default: 100 },
      cursor: { type: 'string' },
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

function requiredString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) return noContextResult(TOOL_NAME);
    let canvasId: string;
    try {
      canvasId = getCanvasId(context);
    } catch {
      return noCanvasIdResult(TOOL_NAME);
    }

    const action = input.action as DatabaseAction;
    const allowed: DatabaseAction[] = ['list_sources', 'get_source', 'create_source', 'add_property', 'create_record', 'update_record', 'archive_record', 'create_view', 'query'];
    if (!allowed.includes(action)) return errorResult('Unknown database action');

    let command: Record<string, unknown>;
    const sourceId = requiredString(input, 'sourceId');
    if (!['list_sources', 'create_source'].includes(action) && !sourceId) return errorResult(`sourceId is required for ${action}`);

    switch (action) {
      case 'list_sources':
        command = { type: 'source.list' };
        break;
      case 'get_source':
        command = { type: 'source.get', sourceId };
        break;
      case 'create_source': {
        const name = requiredString(input, 'name');
        if (!name) return errorResult('name is required for create_source');
        command = { type: 'source.create', name, actor: 'agent', ...(typeof input.description === 'string' ? { description: input.description } : {}) };
        break;
      }
      case 'add_property': {
        const name = requiredString(input, 'name');
        const propertyType = requiredString(input, 'propertyType');
        if (!name || !propertyType) return errorResult('name and propertyType are required for add_property');
        command = { type: 'property.create', sourceId, name, propertyType, actor: 'agent', ...(Array.isArray(input.options) ? { options: input.options } : {}) };
        break;
      }
      case 'create_record':
        command = { type: 'record.create', sourceId, title: typeof input.title === 'string' ? input.title : '', actor: 'agent', ...(input.values && typeof input.values === 'object' ? { values: input.values } : {}) };
        break;
      case 'update_record': {
        const recordId = requiredString(input, 'recordId');
        if (!recordId || typeof input.expectedRevision !== 'number') return errorResult('recordId and expectedRevision are required for update_record');
        command = {
          type: 'record.update', sourceId, recordId, expectedRevision: input.expectedRevision, actor: 'agent',
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(input.values && typeof input.values === 'object' ? { values: input.values } : {}),
        };
        break;
      }
      case 'archive_record': {
        const recordId = requiredString(input, 'recordId');
        if (!recordId || typeof input.expectedRevision !== 'number') return errorResult('recordId and expectedRevision are required for archive_record');
        command = { type: 'record.archive', sourceId, recordId, expectedRevision: input.expectedRevision, archived: input.archived !== false, actor: 'agent' };
        break;
      }
      case 'create_view': {
        const name = requiredString(input, 'name');
        if (!name) return errorResult('name is required for create_view');
        command = {
          type: 'view.create', sourceId, name, viewType: 'table', actor: 'agent',
          ...(input.filter && typeof input.filter === 'object' ? { filter: input.filter } : {}),
          ...(Array.isArray(input.sorts) ? { sorts: input.sorts } : {}),
          ...(input.layout && typeof input.layout === 'object' ? { layout: input.layout } : {}),
        };
        break;
      }
      case 'query':
        command = {
          type: 'query', sourceId, limit: typeof input.limit === 'number' ? input.limit : 100,
          ...(requiredString(input, 'viewId') ? { viewId: requiredString(input, 'viewId') } : {}),
          ...(input.filter && typeof input.filter === 'object' ? { filter: input.filter } : {}),
          ...(Array.isArray(input.sorts) ? { sorts: input.sorts } : {}),
          ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
        };
        break;
    }

    const response = await ipcRequest(context, 'database.execute', { canvasId, command }, { retries: 0 });
    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response.success ? response.data : response),
      error: !response.success,
    };
  },
};
