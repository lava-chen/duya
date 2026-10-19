import type { ExpressionId } from './expressions'
import type { StateId } from './states'

/**
 * duya-side run status, shared by workflow step runs and bot presence.
 * Consumers translate their own lifecycle into these four before rendering.
 */
export type AgentFaceStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * Run status -> engine state, following bloub's own narrative:
 * running collapses into the pulsing three-dot `thinking` (the body IS the
 * animation there), done pops the blue pastille via `notify` (baseBody, so the
 * tile stays and the dot lands on its rim), pending/failed keep the tile and
 * let the rest mood carry the difference.
 */
export const STATUS_TO_STATE: Record<AgentFaceStatus, StateId> = {
  pending: 'idle',
  running: 'thinking',
  done: 'notify',
  failed: 'idle'
}

/**
 * Rest mood per status. Only `baseFace` states (idle/swirl) wear it — while
 * running shows `thinking` or done shows `notify`, those states' own faces
 * win, and the mood takes over again on the way back to idle.
 */
export const STATUS_TO_EXPRESSION: Record<AgentFaceStatus, ExpressionId> = {
  pending: 'somnolent',
  running: 'attentif',
  done: 'heureux',
  failed: 'triste'
}

/**
 * Per-status whole-face motion (grok-bot MOTION-table parity): a sinusoidal
 * bob in viewBox units (the tile is 20 units tall), a fixed tilt, and the
 * bob period in seconds. This is the layer that makes the face READ as alive
 * at 20-32px — the engine's own idle life (blink, sub-pixel drift) is tuned
 * for large avatars and is invisible at roster sizes.
 *
 * amplitudes/tilts are measured against grok's table scaled to a 20-unit
 * tile: pending dozes slowly, running bustles, done bounces proudly,
 * failed sinks.
 */
export interface FaceMotion {
  /** bob amplitude, viewBox units */
  amplitude: number
  /** bob period, seconds */
  period: number
  /** fixed tilt, degrees */
  tilt: number
}

export const FACE_MOTION: Record<AgentFaceStatus, FaceMotion> = {
  pending: { amplitude: 0.9, period: 4.6, tilt: 0 },
  running: { amplitude: 1.2, period: 1.5, tilt: 3 },
  done: { amplitude: 1.5, period: 2.1, tilt: -2 },
  failed: { amplitude: 0.6, period: 3.6, tilt: -4 }
}

/**
 * Eye-dart driver per status: the face re-aims its gaze at a new random
 * target every so often (engine.setLook), which is what makes the
 * expression read as LIVE at roster sizes — bloub's continuous micro-drift
 * is proportionally identical but invisible below ~100px. `done` opts out:
 * the notify pose's gaze-away-from-the-pastille is its own storytelling.
 */
export const FACE_DART: Partial<Record<AgentFaceStatus, {
  yaw: number
  pitch: number
  minEvery: number
  maxEvery: number
}>> = {
  pending: { yaw: 10, pitch: 7, minEvery: 2.4, maxEvery: 4.4 },
  failed: { yaw: 13, pitch: 9, minEvery: 1.8, maxEvery: 3.4 }
}
