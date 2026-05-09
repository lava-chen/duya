import type { ConductorWidget, CanvasElement, ElementKind } from '@/types/conductor';

export function widgetToElementAdapter(widget: ConductorWidget): CanvasElement {
  const elementKind = `widget/${widget.type}` as ElementKind;

  return {
    id: widget.id,
    canvasId: widget.canvasId,
    elementKind,
    position: { x: widget.position.x, y: widget.position.y, w: widget.position.w, h: widget.position.h, zIndex: 0, rotation: 0 },
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
    position: { x: element.position.x, y: element.position.y, w: element.position.w, h: element.position.h },
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