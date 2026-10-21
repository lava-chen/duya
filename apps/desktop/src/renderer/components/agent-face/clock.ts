/**
 * One shared requestAnimationFrame clock for every mounted AgentFace.
 *
 * The engine is a pure function of time, so N faces can share a single rAF
 * loop: this module holds the only wall clock and hands subscribers a
 * monotonically increasing scene time in seconds. All engine setters
 * (`setState`, `setExpression`, ...) must be timestamped with `faceClockNow()`
 * so their morphs line up with the frames the clock emits.
 *
 * The loop self-suspends when the last subscriber leaves and resumes with the
 * same timebase on the next one; rAF itself already throttles to zero on
 * hidden tabs.
 */

type Tick = (t: number) => void

const subscribers = new Set<Tick>()
let rafId = 0
let lastMs = 0
let sceneSeconds = 0

function frame(ms: number) {
  // delta-clamped: a hidden tab must not fast-forward the scene on return
  sceneSeconds += Math.min((ms - lastMs) / 1000, 0.064)
  lastMs = ms
  for (const tick of subscribers) tick(sceneSeconds)
  rafId = subscribers.size > 0 ? requestAnimationFrame(frame) : 0
}

/** Current scene time in seconds — the timestamp all engine setters expect. */
export function faceClockNow(): number {
  return sceneSeconds
}

export function subscribeFaceClock(tick: Tick): () => void {
  subscribers.add(tick)
  if (!rafId) {
    lastMs = performance.now()
    rafId = requestAnimationFrame(frame)
  }
  return () => {
    subscribers.delete(tick)
  }
}
