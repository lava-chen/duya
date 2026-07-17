import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCanvases: vi.fn(),
  createCanvas: vi.fn(),
  updateCanvas: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../db/queries/conductors', () => {
  return {
    listCanvases: mocks.listCanvases,
    createCanvas: mocks.createCanvas,
    updateCanvas: mocks.updateCanvas,
    getCanvasSnapshot: vi.fn(),
    insertElement: vi.fn(),
    updateElementPosition: vi.fn(),
    updateElementConfig: vi.fn(),
    updateElementMetadata: vi.fn(),
    updateElementVizSpec: vi.fn(),
    updateElementSourceCode: vi.fn(),
    deleteElement: vi.fn(),
    writeActionLog: vi.fn(),
    getElement: vi.fn(),
    elementExists: vi.fn(),
    findElementsByType: vi.fn(),
    findAttachedConnectors: vi.fn(),
  };
});

vi.mock('../db/queries/sessions', () => {
  return {
    getSession: mocks.getSession,
    updateSession: mocks.updateSession,
  };
});

vi.mock('../db/connection', () => ({ getDatabase: vi.fn() }));
vi.mock('./document-service', () => ({
  prepareCanvasDocument: vi.fn(),
  syncCanvasDocument: vi.fn(),
}));

import { ConductorExecutorProxy } from './executor-proxy';
import type { ExecutorRpcRequest } from './executor-types';

const firstCanvas = {
  id: 'canvas-1',
  name: 'First',
  description: null,
  layoutConfig: {},
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  projectPath: null,
};

const secondCanvas = {
  ...firstCanvas,
  id: 'canvas-2',
  name: 'Second',
};

function request(payload: Record<string, unknown>, sessionId = 'session-1'): ExecutorRpcRequest {
  return {
    requestId: 'request-1',
    action: 'canvas.manage',
    payload,
    sessionId,
  };
}

describe('ConductorExecutorProxy canvas management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCanvases.mockReturnValue([firstCanvas, secondCanvas]);
    mocks.getSession.mockReturnValue({ id: 'session-1', conductor_canvas_id: 'canvas-1' });
    mocks.updateSession.mockReturnValue({ id: 'session-1', conductor_canvas_id: 'canvas-2' });
  });

  it('uses the durable session binding for current-canvas identity', async () => {
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(request({ action: 'get_current', currentCanvasId: 'canvas-2' }));

    expect(response).toEqual({
      success: true,
      result: { action: 'get_current', currentCanvas: firstCanvas },
    });
  });

  it('persists a switch and emits a renderer management event', async () => {
    const proxy = new ConductorExecutorProxy();
    const changed = vi.fn();
    proxy.setCanvasManagementChangedFn(changed);

    const response = await proxy.execute(request({ action: 'switch', canvasId: 'canvas-2' }));

    expect(response.success).toBe(true);
    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', {
      conductor_mode_enabled: 1,
      conductor_canvas_id: 'canvas-2',
    });
    expect(changed).toHaveBeenCalledWith({
      operation: 'switch',
      sessionId: 'session-1',
      canvas: secondCanvas,
      currentCanvasId: 'canvas-2',
    });
  });

  it('does not create an orphan canvas when the switching session is missing', async () => {
    mocks.getSession.mockReturnValue(undefined);
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(request({ action: 'create', name: 'New board', switchTo: true }));

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    expect(mocks.createCanvas).not.toHaveBeenCalled();
  });
});
