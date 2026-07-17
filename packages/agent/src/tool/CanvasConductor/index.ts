/**
 * Canvas Conductor tools — registration entry point.
 *
 * Fourteen tools for main-agent control of the conductor canvas:
 *   - canvas_manage             : identify/list/create/switch/rename canvases
 *   - canvas_create_element     : create one native element at a time
 *   - canvas_delete_element     : delete an element by ID
 *   - canvas_move_element       : reposition (x, y)
 *   - canvas_resize_element     : resize (w, h)
 *   - canvas_fill_content       : merge-patch content fields (text, url, fileName)
 *   - canvas_style_element      : merge-patch visual style (color, fontSize, stroke)
 *   - canvas_get_context        : read the board as a spatial scene and relationship map
 *   - canvas_list_elements      : list all elements as compact text tree (structured read)
 *   - canvas_find_empty_space   : find a non-overlapping position for a new element
 *   - canvas_auto_layout        : compute a layout PREVIEW (bin-pack / flow / viewport-aware)
 *   - canvas_apply_layout       : commit a layout preview to the canvas
 *   - canvas_capture            : screenshot for vision analysis
 *   - canvas_get_knowledge      : fetch design knowledge section on-demand (no canvas needed)
 *
 * The canvasId is injected via ToolUseContext.conductorCanvasId —
 * the LLM never needs to track canvas state. Register conditionally
 * (only when ChatOptions.conductorMode === true) via
 * `registerCanvasConductorTools(registry)`. The `canvas_get_knowledge`
 * tool is an exception: it does not need a bound canvasId and works
 * standalone, but is registered here for grouping.
 */

import type { ToolRegistry } from '../registry.js';
import type { ToolRegistration } from '../../modes/types.js';
import { definition as manageDefinition, executor as manageExecutor } from './CanvasManageTool.js';
import { definition as createDefinition, executor as createExecutor } from './CanvasCreateElementTool.js';
import { definition as deleteDefinition, executor as deleteExecutor } from './CanvasDeleteElementTool.js';
import { definition as moveDefinition, executor as moveExecutor } from './CanvasMoveElementTool.js';
import { definition as resizeDefinition, executor as resizeExecutor } from './CanvasResizeElementTool.js';
import { definition as fillDefinition, executor as fillExecutor } from './CanvasFillContentTool.js';
import { definition as styleDefinition, executor as styleExecutor } from './CanvasStyleElementTool.js';
import { definition as listElementsDefinition, executor as listElementsExecutor } from './CanvasListElementsTool.js';
import { definition as getContextDefinition, executor as getContextExecutor } from './CanvasGetContextTool.js';
import { definition as findEmptySpaceDefinition, executor as findEmptySpaceExecutor } from './CanvasFindEmptySpaceTool.js';
import { definition as captureDefinition, executor as captureExecutor } from './CanvasCaptureTool.js';
import { definition as getKnowledgeDefinition, executor as getKnowledgeExecutor } from './CanvasGetKnowledgeTool.js';
import { definition as autoLayoutDefinition, executor as autoLayoutExecutor } from './CanvasAutoLayoutTool.js';
import { definition as applyLayoutDefinition, executor as applyLayoutExecutor } from './CanvasApplyLayoutTool.js';

/**
 * The fourteen canvas conductor tools as {@link ToolRegistration} pairs.
 *
 * Plan 224: this is the canonical export — `conductorMode.tools.inject`
 * returns the result of this function so the modifier owns the tool
 * set declaratively. The legacy {@link registerCanvasConductorTools}
 * wrapper remains for any caller that still wants to push them
 * directly into a registry.
 *
 * The first twelve tools expect a bound canvasId in ToolUseContext and
 * will fail without it. `canvas_get_knowledge` is the exception: it
 * works without canvasId because it returns static knowledge content.
 */
export function getCanvasConductorTools(): ToolRegistration[] {
  return [
    { definition: manageDefinition, executor: manageExecutor },
    { definition: createDefinition, executor: createExecutor },
    { definition: deleteDefinition, executor: deleteExecutor },
    { definition: moveDefinition, executor: moveExecutor },
    { definition: resizeDefinition, executor: resizeExecutor },
    { definition: fillDefinition, executor: fillExecutor },
    { definition: styleDefinition, executor: styleExecutor },
    { definition: getContextDefinition, executor: getContextExecutor },
    { definition: listElementsDefinition, executor: listElementsExecutor },
    { definition: findEmptySpaceDefinition, executor: findEmptySpaceExecutor },
    { definition: autoLayoutDefinition, executor: autoLayoutExecutor },
    { definition: applyLayoutDefinition, executor: applyLayoutExecutor },
    { definition: captureDefinition, executor: captureExecutor },
    { definition: getKnowledgeDefinition, executor: getKnowledgeExecutor },
  ];
}

/**
 * Register the fourteen canvas conductor tools on the given registry.
 *
 * @deprecated Plan 224 Phase 3: prefer {@link getCanvasConductorTools}
 * via `conductorMode.tools.inject`. This wrapper is retained for
 * backward compatibility with call sites that push tools into a
 * registry directly.
 */
export function registerCanvasConductorTools(registry: ToolRegistry): void {
  registry.registerAll(getCanvasConductorTools());
}

export {
  definition as canvasManageDefinition,
  executor as canvasManageExecutor,
} from './CanvasManageTool.js';
export {
  definition as canvasCreateElementDefinition,
  executor as canvasCreateElementExecutor,
} from './CanvasCreateElementTool.js';
export {
  definition as canvasDeleteElementDefinition,
  executor as canvasDeleteElementExecutor,
} from './CanvasDeleteElementTool.js';
export {
  definition as canvasMoveElementDefinition,
  executor as canvasMoveElementExecutor,
} from './CanvasMoveElementTool.js';
export {
  definition as canvasResizeElementDefinition,
  executor as canvasResizeElementExecutor,
} from './CanvasResizeElementTool.js';
export {
  definition as canvasFillContentDefinition,
  executor as canvasFillContentExecutor,
} from './CanvasFillContentTool.js';
export {
  definition as canvasStyleElementDefinition,
  executor as canvasStyleElementExecutor,
} from './CanvasStyleElementTool.js';
export {
  definition as canvasCaptureDefinition,
  executor as canvasCaptureExecutor,
} from './CanvasCaptureTool.js';
export {
  definition as canvasGetContextDefinition,
  executor as canvasGetContextExecutor,
} from './CanvasGetContextTool.js';
export {
  definition as canvasListElementsDefinition,
  executor as canvasListElementsExecutor,
} from './CanvasListElementsTool.js';
export {
  definition as canvasFindEmptySpaceDefinition,
  executor as canvasFindEmptySpaceExecutor,
} from './CanvasFindEmptySpaceTool.js';
export {
  definition as canvasGetKnowledgeDefinition,
  executor as canvasGetKnowledgeExecutor,
} from './CanvasGetKnowledgeTool.js';
export {
  definition as canvasAutoLayoutDefinition,
  executor as canvasAutoLayoutExecutor,
} from './CanvasAutoLayoutTool.js';
export {
  definition as canvasApplyLayoutDefinition,
  executor as canvasApplyLayoutExecutor,
} from './CanvasApplyLayoutTool.js';
export {
  ipcRequest as canvasIpcRequest,
  getCanvasId as getCanvasIdFromContext,
} from './ipc-request.js';
