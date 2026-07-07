/**
 * Back-compat shim. The canonical implementation now lives in snap.ts.
 * Existing imports of `detectAlignmentGuides` / `snapToAlignmentGuides`
 * continue to work but are deprecated — new code should call
 * `computeSnap` from snap.ts directly.
 */
export { computeSnap, type AlignmentGuide } from './snap';
