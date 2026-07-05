import type { ConductorWidget, CanvasElement, ElementKind, CanvasPosition } from '../types/conductor';

function normalizePosition(p: { x?: number; y?: number; w?: number; h?: number }): CanvasPosition {
  return {
    x: p.x ?? 0,
    y: p.y ?? 0,
    // 4x3 grid units matches the legacy widget default (see also
    // `widget.move` normalization in conductor-store). Without these
    // fallbacks, missing JSON fields propagate `undefined` through the
    // store and produce `NaN` sizes at render time.
    w: typeof p.w === "number" && Number.isFinite(p.w) ? p.w : 4,
    h: typeof p.h === "number" && Number.isFinite(p.h) ? p.h : 3,
    zIndex: 0,
    rotation: 0,
  };
}

export function widgetToElementAdapter(widget: ConductorWidget): CanvasElement {
  const elementKind = `widget/${widget.type}` as ElementKind;

  return {
    id: widget.id,
    canvasId: widget.canvasId,
    elementKind,
    position: normalizePosition(widget.position),
    config: { ...widget.data, ...widget.config },
    vizSpec: null,
    sourceCode: widget.sourceCode,
    state: widgetStateToElementState(widget.state),
    dataVersion: widget.dataVersion,
    permissions: widget.permissions,
    metadata: {
      label: `${widget.kind}:${widget.type}`,
      tags: [],
      createdBy: 'user',
    },
    createdAt: widget.createdAt,
    updatedAt: widget.updatedAt,
  };
}

export function elementToWidgetAdapter(element: CanvasElement): ConductorWidget | null {
  if (!element.elementKind.startsWith('widget/')) return null;

  const type = element.elementKind.replace('widget/', '');
  return {
    id: element.id,
    canvasId: element.canvasId,
    kind: 'builtin',
    type,
    position: normalizePosition(element.position),
    config: element.config,
    data: element.config,
    dataVersion: element.dataVersion,
    sourceCode: element.sourceCode,
    state: elementStateToWidgetState(element.state),
    permissions: element.permissions,
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
  };
}

function widgetStateToElementState(state: string): CanvasElement['state'] {
  switch (state) {
    case 'idle': return 'idle';
    case 'loading': return 'loading';
    case 'error': return 'error';
    case 'agent-editing': return 'rendering';
    default: return 'idle';
  }
}

function elementStateToWidgetState(state: string): ConductorWidget['state'] {
  switch (state) {
    case 'idle': return 'idle';
    case 'loading': return 'loading';
    case 'error': return 'error';
    case 'rendering': return 'agent-editing';
    default: return 'idle';
  }
}