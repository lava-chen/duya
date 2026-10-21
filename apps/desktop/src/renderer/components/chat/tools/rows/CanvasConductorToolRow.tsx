// CanvasConductorToolRow — renders the canvas_* tool family with
// human-readable verbs and summaries instead of raw JSON dumps.
//
// Each tool maps to a stable action key (manage, create, batchCreate, delete,
// move, resize, fill, style, list, findEmptySpace, autoLayout,
// applyLayout, capture, getKnowledge). The row picks the running /
// done / error i18n key from that action and shows a concise summary
// derived from the tool input and result.
//
// Clicking the row locates the corresponding element on the canvas,
// opens the conductor panel if needed, and centers the element in
// view instead of expanding a JSON card.

'use client';

import React, { useMemo, useState } from 'react';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import { useOptionalPanel } from '@/hooks/usePanel';
import { useConversationStore } from '@/stores/conversation-store';
import { useConductorStore } from '@duya/conductor/renderer/stores/conductor-store';
import type { TranslationKey } from '@/i18n';
import type { ToolAction, ToolStatus } from '../types';

interface CanvasConductorToolRowProps {
  tool: ToolAction;
}

type CanvasAction =
  | 'manage'
  | 'create'
  | 'batchCreate'
  | 'delete'
  | 'move'
  | 'resize'
  | 'fill'
  | 'style'
  | 'list'
  | 'findEmptySpace'
  | 'autoLayout'
  | 'applyLayout'
  | 'capture'
  | 'getKnowledge'
  | 'database';

function getCanvasAction(name: string): CanvasAction {
  switch (name.toLowerCase()) {
    case 'canvas_manage':
      return 'manage';
    case 'canvas_create_element':
      return 'create';
    case 'canvas_batch_create':
      return 'batchCreate';
    case 'canvas_delete_element':
      return 'delete';
    case 'canvas_move_element':
      return 'move';
    case 'canvas_resize_element':
      return 'resize';
    case 'canvas_fill_content':
      return 'fill';
    case 'canvas_style_element':
      return 'style';
    case 'canvas_list_elements':
      return 'list';
    case 'canvas_find_empty_space':
      return 'findEmptySpace';
    case 'canvas_auto_layout':
      return 'autoLayout';
    case 'canvas_apply_layout':
      return 'applyLayout';
    case 'canvas_capture':
      return 'capture';
    case 'canvas_get_knowledge':
      return 'getKnowledge';
    case 'database_manage':
      return 'database';
    default:
      return 'create';
  }
}

function verbKeyFor(action: CanvasAction, status: ToolStatus): TranslationKey {
  if (status === 'running') {
    return `streaming.toolAction.running.canvas.${action}` as TranslationKey;
  }
  if (status === 'error') {
    return `streaming.toolAction.error.canvas.${action}` as TranslationKey;
  }
  return `streaming.toolAction.done.canvas.${action}` as TranslationKey;
}

function truncate(str: string, max = 60): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function shortId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  // Keep just enough characters to be useful without crowding the row.
  return id.length > 12 ? id.slice(0, 8) : id;
}

function getTargetId(input: Record<string, unknown>): string | undefined {
  if (typeof input.elementId === 'string' && input.elementId) {
    return input.elementId;
  }
  if (typeof input.ref === 'string' && input.ref) {
    return input.ref;
  }
  return undefined;
}

function tryParseResult(result: string | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined;
  try {
    const parsed = JSON.parse(result);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canvas tool results are wrapped as `{ success, result }` by the
 * executor proxy. Unwrap the inner `result` object for summary / focus
 * extraction; if the payload is already unwrapped, return it as-is.
 */
function parseToolResult(result: string | undefined): Record<string, unknown> | undefined {
  const parsed = tryParseResult(result);
  if (!parsed) return undefined;
  if (parsed.success === true && parsed.result && typeof parsed.result === 'object' && !Array.isArray(parsed.result)) {
    return parsed.result as Record<string, unknown>;
  }
  return parsed;
}

function computeSummary(tool: ToolAction, action: CanvasAction): string {
  const input = (tool.input || {}) as Record<string, unknown>;
  const resultData = parseToolResult(tool.result);

  switch (action) {
    case 'manage': {
      const operation = typeof input.action === 'string' ? input.action : 'get_current';
      const name = typeof input.name === 'string' ? input.name : '';
      const currentCanvas = resultData?.currentCanvas;
      const currentName = currentCanvas && typeof currentCanvas === 'object'
        ? (currentCanvas as Record<string, unknown>).name
        : undefined;
      if (operation === 'list' && Array.isArray(resultData?.canvases)) {
        return `${resultData.canvases.length} canvases`;
      }
      if (name) return truncate(`${operation}: ${name}`);
      if (typeof currentName === 'string') return truncate(`${operation}: ${currentName}`);
      return operation;
    }
    case 'create': {
      const kind = typeof input.kind === 'string' ? input.kind : '';
      const text =
        typeof (input.config as Record<string, unknown> | undefined)?.text === 'string'
          ? ((input.config as Record<string, unknown>).text as string)
          : '';
      // Prefer the human-written text; only fall back to kind / short id.
      if (text) return truncate(text);
      return kind || shortId(getTargetId(input)) || 'element';
    }
    case 'batchCreate': {
      const ops = input.operations;
      const count = Array.isArray(ops) ? ops.length : 0;
      return count > 0 ? `${count} operations` : 'batch create';
    }
    case 'delete':
      // No user-facing text for a delete; a count reference is enough.
      return shortId(getTargetId(input)) || '1 element';
    case 'move': {
      const target = shortId(getTargetId(input));
      const x = typeof input.x === 'number' ? input.x : undefined;
      const y = typeof input.y === 'number' ? input.y : undefined;
      const coord = x !== undefined && y !== undefined ? `(${x}, ${y})` : '';
      return target && coord ? `${target} → ${coord}` : coord || target || 'element';
    }
    case 'resize': {
      const target = shortId(getTargetId(input));
      const w = typeof input.w === 'number' ? input.w : undefined;
      const h = typeof input.h === 'number' ? input.h : undefined;
      const size = w !== undefined && h !== undefined ? `${w}×${h}` : '';
      return target && size ? `${target} → ${size}` : size || target || 'element';
    }
    case 'fill': {
      // The text the user actually wrote is the useful part.
      const content = (input.content || input) as Record<string, unknown>;
      const text = typeof content.text === 'string' ? content.text : '';
      if (text) return truncate(text);
      return shortId(getTargetId(input)) || 'element';
    }
    case 'style': {
      const target = shortId(getTargetId(input));
      const style = (input.style || {}) as Record<string, unknown>;
      const keys = Object.keys(style).join(', ');
      if (target && keys) return truncate(`${target}: ${keys}`);
      return target || keys || 'element';
    }
    case 'list': {
      if (resultData && typeof resultData.count === 'number') {
        return `${resultData.count} elements`;
      }
      return 'canvas';
    }
    case 'findEmptySpace': {
      if (resultData && typeof resultData.x === 'number' && typeof resultData.y === 'number') {
        const w = typeof resultData.w === 'number' ? resultData.w : '';
        const h = typeof resultData.h === 'number' ? resultData.h : '';
        const size = w && h ? ` ${w}×${h}` : '';
        return `(${resultData.x}, ${resultData.y})${size}`;
      }
      return 'empty space';
    }
    case 'autoLayout': {
      const algo = typeof input.algorithm === 'string' ? input.algorithm : 'bin-pack';
      return algo;
    }
    case 'applyLayout': {
      const preview = input.preview;
      const count = Array.isArray(preview) ? preview.length : 0;
      return count > 0 ? `${count} elements` : 'layout';
    }
    case 'capture': {
      const scope = typeof input.scope === 'string' ? input.scope : 'viewport';
      const filePath = typeof resultData?.filePath === 'string' ? resultData.filePath : '';
      if (filePath) {
        const name = filePath.split(/[/\\]/).pop() || filePath;
        return `${scope}: ${name}`;
      }
      return scope;
    }
    case 'getKnowledge': {
      const section = typeof input.section === 'string' ? input.section : '';
      return section || 'design knowledge';
    }
    case 'database': {
      const operation = typeof input.action === 'string' ? input.action : 'query';
      const name = typeof input.name === 'string' ? input.name : '';
      const title = typeof input.title === 'string' ? input.title : '';
      return truncate([operation, name || title].filter(Boolean).join(': ') || 'project database');
    }
    default:
      return 'canvas';
  }
}

function getFocusElementId(tool: ToolAction, action: CanvasAction): string | undefined {
  const input = (tool.input || {}) as Record<string, unknown>;
  const resultData = parseToolResult(tool.result);

  switch (action) {
    case 'create': {
      const diff = resultData?.diff;
      const element = diff && typeof diff === 'object' ? (diff as Record<string, unknown>).element : undefined;
      if (element && typeof element === 'object' && typeof (element as Record<string, unknown>).id === 'string') {
        return (element as Record<string, unknown>).id as string;
      }
      return getTargetId(input);
    }
    case 'batchCreate': {
      const diff = resultData?.diff;
      const elements = diff && typeof diff === 'object' ? (diff as Record<string, unknown>).elements : undefined;
      if (Array.isArray(elements) && elements.length > 0) {
        const first = elements[0];
        if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).id === 'string') {
          return (first as Record<string, unknown>).id as string;
        }
      }
      return undefined;
    }
    case 'delete':
      // The element no longer exists; focusing it would do nothing.
      return undefined;
    case 'move':
    case 'resize':
    case 'fill':
    case 'style':
      return getTargetId(input);
    default:
      return undefined;
  }
}

export function CanvasConductorToolRow({ tool }: CanvasConductorToolRowProps) {
  const [hovered, setHovered] = useState(false);
  const panel = useOptionalPanel();
  const status = getStatus(tool);
  const action = useMemo(() => getCanvasAction(tool.name), [tool.name]);
  const summary = useMemo(() => computeSummary(tool, action), [tool, action]);
  const focusElementId = useMemo(() => getFocusElementId(tool, action), [tool, action]);
  const verbKey = verbKeyFor(action, status);
  const isFocusable = !!focusElementId;

  const handleClick = () => {
    if (!focusElementId) return;

    const conductor = useConductorStore.getState();
    const currentView = useConversationStore.getState().currentView;

    // Make sure the canvas is visible. If the user is already in the
    // full conductor view, we only need to center. Otherwise open the
    // conductor side panel and let SidebarConductorView fulfill the
    // focus request once the snapshot is loaded.
    if (currentView !== 'conductor' && panel) {
      panel.openOrActivatePage('conductor');
    }

    conductor.setSelectedElementId(focusElementId);
    conductor.setPendingChatFocusElementId(focusElementId);
    // If the canvas is already mounted and the element is loaded, center
    // immediately. If not, SidebarConductorView will apply the pending
    // focus once the element appears.
    conductor.centerOnElement(focusElementId);
  };

  return (
    <ActionRowChrome
      status={status}
      verbKey={verbKey}
      canExpand={false}
      expanded={false}
      hovered={hovered}
      durationMs={tool.durationMs}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      buttonClassName={isFocusable ? 'cursor-pointer' : 'cursor-default'}
    >
      {summary}
    </ActionRowChrome>
  );
}
