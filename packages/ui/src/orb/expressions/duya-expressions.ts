/**
 * expressions/duya-expressions.ts — the 4 base duya mascot expressions.
 *
 * One expression per orb state. Adding new ones is a data-only
 * change: write a new entry, hand it to the renderer, done.
 *
 * ViewBox: 0..100 both axes. Body is centered at (50, 55); eye at
 * (60, 42) — the same asymmetric placement as assets/icon.png
 * (creature faces slightly right). Mouth at (62, 70).
 *
 * Plan 453: Task F (foundation). The body itself is identical
 * across expressions; only the eye/mouth/pupil parameters differ.
 * The renderer in DuyaMascot.tsx takes a single `Expression` and
 * applies it.
 */

import type { Expression, MouthKind } from './types';

/**
 * The 5 canonical mouth paths. Stored as separate constants so the
 * tween (`pathTween.ts`) can interpolate between two same-shape
 * paths with the same command sequence. A smile and an open
 * mouth have different command sequences and therefore cannot
 * be linearly interpolated — the tween falls back to a
 * cross-fade for those transitions.
 */
export const MOUTH_PATHS: Record<MouthKind, string> = {
  smile: 'M 52 68 Q 62 76 76 66',
  straight: 'M 52 70 L 76 70',
  open: 'M 56 67 Q 62 78 68 67 Q 62 75 56 67 Z',
  flat: 'M 54 71 L 72 71',
  hidden: '',
};

export const EXPRESSION_NEUTRAL: Expression = {
  id: 'neutral',
  label: 'Neutral (DORMANT / awake, idle)',
  eyeOpenness: 1.0,
  eyeRx: 13,
  eyeRy: 11,
  pupilDx: 0,
  pupilDy: 0,
  pupilR: 5.5,
  mouth: 'smile',
  mouthOpenness: 0.35,
  bodyScale: 1.0,
  glintVisible: true,
};

export const EXPRESSION_FOCUSED: Expression = {
  id: 'focused',
  label: 'Focused (INPUT / user is typing)',
  eyeOpenness: 0.78,
  eyeRx: 13,
  eyeRy: 9,
  pupilDx: 0,
  pupilDy: 1,
  pupilR: 5.5,
  mouth: 'flat',
  mouthOpenness: 0.0,
  bodyScale: 1.0,
  glintVisible: true,
};

export const EXPRESSION_THINKING: Expression = {
  id: 'thinking',
  label: 'Thinking (LOADING / agent working)',
  eyeOpenness: 0.0,
  eyeRx: 13,
  eyeRy: 0,
  pupilDx: 0,
  pupilDy: 0,
  pupilR: 0,
  mouth: 'open',
  mouthOpenness: 0.5,
  bodyScale: 0.96,
  glintVisible: false,
};

export const EXPRESSION_HAPPY: Expression = {
  id: 'happy',
  label: 'Happy (RESULT / agent delivered)',
  eyeOpenness: 1.0,
  eyeRx: 14,
  eyeRy: 12,
  pupilDx: 0,
  pupilDy: -1,
  pupilR: 5.5,
  mouth: 'smile',
  mouthOpenness: 0.7,
  bodyScale: 1.04,
  glintVisible: true,
};

/**
 * Lookup table for the renderer. Keyed by the orb's 4 states (which
 * match the `data-state` attribute on `.orb-window`). Adding a
 * new state is a one-line addition here + a new entry in the
 * `Expression` map.
 */
export const EXPRESSION_BY_STATE: Record<string, Expression> = {
  DORMANT: EXPRESSION_NEUTRAL,
  INPUT: EXPRESSION_FOCUSED,
  LOADING: EXPRESSION_THINKING,
  RESULT: EXPRESSION_HAPPY,
};
