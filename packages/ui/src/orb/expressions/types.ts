/**
 * expressions/types.ts — declarative expression model for DuyaMascot.
 *
 * The mascot has 4 visible parameters (eye geometry, pupil offset,
 * mouth, body squash). Each *expression* is a frozen snapshot of
 * those parameters. The renderer (`DuyaMascot.tsx`) reads an
 * `Expression` and turns it into SVG attributes; transitions between
 * expressions are *not* the renderer's job (it draws whatever
 * `Expression` it gets). Transitions live in
 * `useExpressionTransition` (added in a follow-up) which can swap
 * `Expression` values frame-by-frame via path string interpolation.
 *
 * Design notes:
 *   - Coordinates are in the viewBox space (0..100, 0..100). The
 *     renderer's viewBox is fixed; the caller scales via CSS.
 *   - Mouth `d` is an SVG path string. We deliberately store it as
 *     a string (not a parsed Path) because the tween
 *     (`pathTween.ts`) operates on string diffs and a parsed Path
 *     would force a normalization step that loses information
 *     when two paths have different command sets.
 *   - `eyeOpenness` 0..1, where 0 = closed (just a line / arc) and
 *     1 = fully open. The renderer chooses how to interpolate
 *     between fully open and fully closed (CSS transform vs.
 *     SMIL animation vs. a keyframed path swap).
 *   - `pupilDx`/`pupilDy` are offsets in viewBox units (range
 *     roughly -3..3 for the duya single-eye layout; the renderer's
 *     gaze hook can scale these when tracking the cursor).
 *
 * Plan 453: Task F (foundation). Adding new expressions is a
 * data-only change.
 */

export type MouthKind = 'smile' | 'straight' | 'open' | 'flat' | 'hidden';

/**
 * Snapshot of every animatable mascot parameter. The renderer
 * treats this as immutable; transitions produce a new `Expression`
 * each frame.
 */
export interface Expression {
  /** Stable id used by the tween to look up a "from" / "to" pair. */
  id: string;

  /** Friendly label for debug logs / tests. */
  label: string;

  /** Eye opening 0..1. 0 = a flat arc (closed), 1 = full ellipse. */
  eyeOpenness: number;

  /**
   * Eye ellipse axes (viewBox units). ry collapses toward 0 as
   * eyeOpenness falls; rx stays constant so a "wink" reads as a
   * horizontal line at the eye's center.
   */
  eyeRx: number;
  eyeRy: number;

  /**
   * Pupil offset from the eye center, in viewBox units. The gaze
   * hook multiplies this by a tracking factor in DORMANT/INPUT
   * states; LOADING zeroes it (eye "looks inward" while thinking).
   */
  pupilDx: number;
  pupilDy: number;

  /** Pupil radius. Round for duya, NOT slitted like bloub. */
  pupilR: number;

  /**
   * Mouth path `d` attribute. Five canonical kinds defined in
   * `duya-expressions.ts`. The renderer does not interpret; it
   * just sets `d` on the mouth path. Tweening between two mouth
   * paths requires same-command structure (linear interpolation
   * only works on paths with the same command sequence).
   */
  mouth: MouthKind;
  mouthOpenness: number;

  /**
   * Optional body squash factor (1.0 = rest, 0.9 = squished
   * horizontally, 1.1 = stretched). The renderer scales the
   * whole body group by this factor. Used for the "happy"
   * bounce in the RESULT state.
   */
  bodyScale: number;

  /**
   * Whether the secondary glint (the small white highlight on the
   * upper-right of the body) is visible. Hidden in `thinking` so
   * the face reads as "downcast eyes".
   */
  glintVisible: boolean;
}
