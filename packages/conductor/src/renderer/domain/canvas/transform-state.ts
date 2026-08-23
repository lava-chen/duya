/**
 * Live canvas view transform, shared as a plain mutable snapshot.
 *
 * CanvasArea writes pan/zoom here on every transform change so
 * non-React consumers (connector hit-testing, agent captures) can read
 * the current view without subscribing to component state. Lives in the
 * domain layer so renderer utilities can import it without pulling in
 * the component tree.
 */
export const canvasTransformState = { panX: 0, panY: 0, zoom: 1 };
