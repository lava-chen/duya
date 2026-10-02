import { registerEyeFitShape } from './eyefit'
import { superellipseProfile } from './shape'

/**
 * Fixed tile geometry of the duya agent face, in SVG viewBox units.
 *
 * A wide superellipse (ratio 1.2 : 1, exponent 2.8) standing 20 units tall —
 * the same height the ZCode-style workflow tile renders at, just longer.
 * The shape is FIXED: unlike bloub's customizer it is not a user choice, so
 * every consumer shares one profile instance.
 */
export const AGENT_FACE_TILE = {
  width: 24,
  height: 20,
  exponent: 2.8
} as const

/** Half height = the engine's ball radius; all engine units scale from it. */
export const AGENT_FACE_SCALE = AGENT_FACE_TILE.height / 2

/**
 * The one body profile every face wears, in ball-radius units (1.0 tall,
 * 1.2 wide). `superellipseProfile` bakes the ratio into the radii, so the
 * rendered extents come out as width = 1.2 * scale, height = 1.0 * scale.
 */
export const AGENT_FACE_RADII: number[] = superellipseProfile(
  AGENT_FACE_TILE.exponent,
  AGENT_FACE_TILE.width / AGENT_FACE_TILE.height,
  1
)

/**
 * Identity ring for agent bodies (duya port of the ZCode tile palette).
 * Pick by `avatarIndex % length`, or hash the agent name when unnumbered.
 */
export const AGENT_FACE_COLORS = [
  '#54B9A6',
  '#F19D38',
  '#6464EF',
  '#885CF5',
  '#3C82F6',
  '#ED712E',
  '#EB4699',
  '#5BC67A',
  '#EA4045'
] as const

/**
 * Fit the eyes to this out-of-catalogue body once, at import time. The eyefit
 * offset table is keyed by radii-array REFERENCE — the engine must receive
 * exactly this array instance for the fitted offsets to apply.
 */
registerEyeFitShape(AGENT_FACE_RADII)