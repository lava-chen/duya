export interface LayoutElement {
  id: string;
  position: { x: number; y: number; w: number; h: number; zIndex: number; rotation: number };
  metadata: { locked?: boolean; priority?: 'high' | 'mid' | 'low' };
}

export interface LayoutResult {
  id: string;
  position: { x: number; y: number; w: number; h: number; zIndex: number; rotation: number };
}
