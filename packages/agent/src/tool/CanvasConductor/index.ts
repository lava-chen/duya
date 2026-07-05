/**
 * Canvas Conductor tools — registration entry point.
 *
 * Eleven tools for main-agent control of the conductor canvas:
 *   - canvas_create_element     : create a new sticky / image / file / connector / widget
 *   - canvas_batch_create       : create multiple elements + connectors in one call (with ref bindings)
 *   - canvas_delete_element     : delete an element by ID
 *   - canvas_move_element       : reposition (x, y)
 *   - canvas_resize_element     : resize (w, h)
 *   - canvas_fill_content       : merge-patch content fields (text, url, fileName)
 *   - canvas_style_element      : merge-patch visual style (color, fontSize, stroke)
 *   - canvas_list_elements      : list all elements as compact text tree (structured read)
 *   - canvas_find_empty_space   : find a non-overlapping position for a new element
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
import { definition as createDefinition, executor as createExecutor } from './CanvasCreateElementTool.js';
import { definition as batchCreateDefinition, executor as batchCreateExecutor } from './CanvasBatchCreateTool.js';
import { definition as deleteDefinition, executor as deleteExecutor } from './CanvasDeleteElementTool.js';
import { definition as moveDefinition, executor as moveExecutor } from './CanvasMoveElementTool.js';
import { definition as resizeDefinition, executor as resizeExecutor } from './CanvasResizeElementTool.js';
import { definition as fillDefinition, executor as fillExecutor } from './CanvasFillContentTool.js';
import { definition as styleDefinition, executor as styleExecutor } from './CanvasStyleElementTool.js';
import { definition as listElementsDefinition, executor as listElementsExecutor } from './CanvasListElementsTool.js';
import { definition as findEmptySpaceDefinition, executor as findEmptySpaceExecutor } from './CanvasFindEmptySpaceTool.js';
import { definition as captureDefinition, executor as captureExecutor } from './CanvasCaptureTool.js';
import { definition as getKnowledgeDefinition, executor as getKnowledgeExecutor } from './CanvasGetKnowledgeTool.js';

/**
 * Register the eleven canvas conductor tools on the given registry.
 * Call only when conductorMode is enabled — the first ten tools
 * expect a bound canvasId in ToolUseContext and will fail without it.
 * `canvas_get_knowledge` is the exception: it works without canvasId
 * because it returns static knowledge content.
 */
export function registerCanvasConductorTools(registry: ToolRegistry): void {
  registry.register(createDefinition, createExecutor);
  registry.register(batchCreateDefinition, batchCreateExecutor);
  registry.register(deleteDefinition, deleteExecutor);
  registry.register(moveDefinition, moveExecutor);
  registry.register(resizeDefinition, resizeExecutor);
  registry.register(fillDefinition, fillExecutor);
  registry.register(styleDefinition, styleExecutor);
  registry.register(listElementsDefinition, listElementsExecutor);
  registry.register(findEmptySpaceDefinition, findEmptySpaceExecutor);
  registry.register(captureDefinition, captureExecutor);
  registry.register(getKnowledgeDefinition, getKnowledgeExecutor);
}

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
  definition as canvasBatchCreateDefinition,
  executor as canvasBatchCreateExecutor,
} from './CanvasBatchCreateTool.js';
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
  ipcRequest as canvasIpcRequest,
  getCanvasId as getCanvasIdFromContext,
} from './ipc-request.js';
