import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCanvases: vi.fn(),
  listCanvasesForProject: vi.fn(),
  createCanvas: vi.fn(),
  updateCanvas: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  getCanvasSnapshot: vi.fn(),
}));

vi.mock('../db/queries/conductors', () => {
  return {
    listCanvases: mocks.listCanvases,
    listCanvasesForProject: mocks.listCanvasesForProject,
    createCanvas: mocks.createCanvas,
    updateCanvas: mocks.updateCanvas,
    getCanvasSnapshot: mocks.getCanvasSnapshot,
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

  it('filters list by project_path when the session has a working directory', async () => {
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      working_directory: '/proj/A',
      conductor_canvas_id: 'canvas-1',
    });
    mocks.listCanvasesForProject.mockReturnValue([firstCanvas]);
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(request({ action: 'list' }));

    expect(response.success).toBe(true);
    expect(mocks.listCanvasesForProject).toHaveBeenCalledWith('/proj/A');
    expect(mocks.listCanvasesForProject).toHaveBeenCalledTimes(1);
    // listCanvases is invoked exactly once — by resolveCurrentCanvas to
    // look up the current canvas by id. The list branch itself must use
    // the scoped listCanvasesForProject instead.
    expect(mocks.listCanvases).toHaveBeenCalledTimes(1);
    // The filtered list is returned, with the current canvas (canvas-1)
    // already present so no defensive unshift is needed.
    expect((response.result as { canvases: { id: string }[] }).canvases.map((c) => c.id)).toEqual(['canvas-1']);
  });

  it('passes the session working directory as projectPath to createCanvas', async () => {
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      working_directory: '/proj/A',
      conductor_canvas_id: null,
    });
    mocks.createCanvas.mockReturnValue({
      id: 'canvas-new',
      name: 'New board',
      description: null,
      layoutConfig: {},
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      projectPath: '/proj/A',
    });
    const proxy = new ConductorExecutorProxy();
    const changed = vi.fn();
    proxy.setCanvasManagementChangedFn(changed);

    const response = await proxy.execute(
      request({ action: 'create', name: 'New board', switchTo: false }),
    );

    expect(response.success).toBe(true);
    expect(mocks.createCanvas).toHaveBeenCalledWith({
      name: 'New board',
      description: undefined,
      projectPath: '/proj/A',
    });
    // Without this broadcast the renderer's canvas list stays stale
    // and the agent reports the create as a false success (plan 240).
    expect(changed).toHaveBeenCalledWith({
      operation: 'create',
      sessionId: 'session-1',
      canvas: expect.objectContaining({ id: 'canvas-new', name: 'New board' }),
      currentCanvasId: undefined,
    });
  });

  it('emits a rename event so the renderer can update its canvas name', async () => {
    mocks.updateCanvas.mockReturnValue({ ...firstCanvas, name: 'Renamed' });
    const proxy = new ConductorExecutorProxy();
    const changed = vi.fn();
    proxy.setCanvasManagementChangedFn(changed);

    const response = await proxy.execute(
      request({ action: 'rename', canvasId: 'canvas-1', name: 'Renamed' }),
    );

    expect(response.success).toBe(true);
    expect(mocks.updateCanvas).toHaveBeenCalledWith('canvas-1', { name: 'Renamed' });
    expect(changed).toHaveBeenCalledWith({
      operation: 'rename',
      sessionId: 'session-1',
      canvas: expect.objectContaining({ id: 'canvas-1', name: 'Renamed' }),
      currentCanvasId: 'canvas-1',
    });
  });

  it('rejects switch to a canvas bound to a different project', async () => {
    const foreignCanvas = { ...firstCanvas, id: 'canvas-foreign', projectPath: '/proj/B' };
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      working_directory: '/proj/A',
      conductor_canvas_id: 'canvas-1',
    });
    mocks.listCanvases.mockReturnValue([firstCanvas, foreignCanvas]);
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(request({ action: 'switch', canvasId: 'canvas-foreign' }));

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('CANVAS_NOT_ACCESSIBLE');
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('allows switch to a legacy canvas whose project_path is null', async () => {
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      working_directory: '/proj/A',
      conductor_canvas_id: 'canvas-1',
    });
    // secondCanvas has projectPath: null (legacy/shared)
    mocks.listCanvases.mockReturnValue([firstCanvas, secondCanvas]);
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(request({ action: 'switch', canvasId: 'canvas-2' }));

    expect(response.success).toBe(true);
    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', {
      conductor_mode_enabled: 1,
      conductor_canvas_id: 'canvas-2',
    });
  });

  it('rejects rename of a canvas bound to a different project', async () => {
    const foreignCanvas = { ...firstCanvas, id: 'canvas-foreign', projectPath: '/proj/B' };
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      working_directory: '/proj/A',
      conductor_canvas_id: 'canvas-1',
    });
    mocks.listCanvases.mockReturnValue([firstCanvas, foreignCanvas]);
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(
      request({ action: 'rename', canvasId: 'canvas-foreign', name: 'Hijacked' }),
    );

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('CANVAS_NOT_ACCESSIBLE');
    expect(mocks.updateCanvas).not.toHaveBeenCalled();
  });
});

/**
 * canvas.find_empty_space — Plan 239.
 *
 * The proxy just forwards to ConductorDbService.findEmptySpace. These
 * tests stub getCanvasSnapshot so we can verify the response shape and
 * the overlap-rejection contract the agent depends on.
 */
describe('ConductorExecutorProxy canvas.find_empty_space', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCanvases.mockReturnValue([firstCanvas]);
    mocks.getSession.mockReturnValue({ id: 'session-1', conductor_canvas_id: 'canvas-1' });
  });

  function findEmptyRequest(
    payload: Record<string, unknown>,
    sessionId = 'session-1',
  ): ExecutorRpcRequest {
    return {
      requestId: 'request-fes',
      action: 'canvas.find_empty_space',
      payload,
      sessionId,
    };
  }

  it('returns a placement plus cornerDistance on an empty canvas', async () => {
    mocks.getCanvasSnapshot.mockReturnValue({
      canvas: firstCanvas,
      elements: [],
      widgets: [],
      actionCursor: 0,
    });
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(findEmptyRequest({ canvasId: 'canvas-1', w: 4, h: 3 }));

    expect(response.success).toBe(true);
    const result = response.result as {
      x: number;
      y: number;
      w: number;
      h: number;
      overlapsExisting: boolean;
      cornerDistance: number;
    };
    // Center of the 40x30 canvas is (20, 15); for a 4x3 rectangle the
    // ideal top-left is (18, 13.5).
    expect(result.x).toBeCloseTo(18, 5);
    expect(result.y).toBeCloseTo(13.5, 5);
    expect(result.w).toBe(4);
    expect(result.h).toBe(3);
    expect(result.overlapsExisting).toBe(false);
    expect(typeof result.cornerDistance).toBe('number');
    expect(result.cornerDistance).toBeGreaterThanOrEqual(0);
  });

  it('returns overlapsExisting=true when no fully empty placement fits', async () => {
    // Cover the entire canvas with one obstacle so nothing fits.
    mocks.getCanvasSnapshot.mockReturnValue({
      canvas: firstCanvas,
      elements: [
        {
          id: 'cover',
          canvasId: 'canvas-1',
          elementKind: 'native/shape',
          position: { x: 0, y: 0, w: 40, h: 30 },
          config: {},
          vizSpec: null,
          state: 'idle',
          dataVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      widgets: [],
      actionCursor: 0,
    });
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(findEmptyRequest({ canvasId: 'canvas-1', w: 4, h: 3 }));

    expect(response.success).toBe(true);
    const result = response.result as { overlapsExisting: boolean; reason?: string };
    expect(result.overlapsExisting).toBe(true);
    expect(typeof result.reason).toBe('string');
  });

  it('excludes connector elements from the obstacle list', async () => {
    // A single connector occupies zero area so it must never block the
    // candidate sweep — otherwise a busy diagram would falsely flag
    // overlapsExisting=true.
    mocks.getCanvasSnapshot.mockReturnValue({
      canvas: firstCanvas,
      elements: [
        {
          id: 'line',
          canvasId: 'canvas-1',
          elementKind: 'native/connector',
          position: { x: 0, y: 0, w: 0, h: 0 },
          config: {},
          vizSpec: null,
          state: 'idle',
          dataVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      widgets: [],
      actionCursor: 0,
    });
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(findEmptyRequest({ canvasId: 'canvas-1', w: 4, h: 3 }));

    expect(response.success).toBe(true);
    expect((response.result as { overlapsExisting: boolean }).overlapsExisting).toBe(false);
  });

  it('rejects when the canvas does not exist', async () => {
    mocks.getCanvasSnapshot.mockReturnValue(null);
    const proxy = new ConductorExecutorProxy();

    const response = await proxy.execute(findEmptyRequest({ canvasId: 'missing' }));

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('CANVAS_NOT_FOUND');
  });
});
