const DEFAULT_GRID_SIZE = 8;

export function snapToGrid(value: number, gridSize: number = DEFAULT_GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize;
}

export function snapPointToGrid(
  x: number,
  y: number,
  gridSize: number = DEFAULT_GRID_SIZE,
): { x: number; y: number } {
  return {
    x: snapToGrid(x, gridSize),
    y: snapToGrid(y, gridSize),
  };
}

export function snapRectToGrid(
  x: number,
  y: number,
  w: number,
  h: number,
  gridSize: number = DEFAULT_GRID_SIZE,
): { x: number; y: number; w: number; h: number } {
  return {
    x: snapToGrid(x, gridSize),
    y: snapToGrid(y, gridSize),
    w: snapToGrid(w, gridSize),
    h: snapToGrid(h, gridSize),
  };
}
