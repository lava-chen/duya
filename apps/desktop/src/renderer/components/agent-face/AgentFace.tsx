import { useEffect, useId, useRef } from 'react'
import { faceClockNow, subscribeFaceClock } from './clock'
import { NOTIF_BLUE } from './decor'
import { BotEngine, type BotFrame } from './engine'
import { EXPRESSION_BY_ID, type ExpressionId } from './expressions'
import { createRng } from './math'
import type { StateId } from './states'
import {
  FACE_DART,
  FACE_MOTION,
  STATUS_TO_EXPRESSION,
  STATUS_TO_STATE,
  type AgentFaceStatus
} from './status'
import { AGENT_FACE_COLORS, AGENT_FACE_RADII, AGENT_FACE_SCALE, AGENT_FACE_TILE } from './tile'

// convenience re-export: consumers pick identity colors from the one entry point
export { AGENT_FACE_COLORS }
export type { AgentFaceStatus } from './status'

const VB_W = AGENT_FACE_TILE.width
const VB_H = AGENT_FACE_TILE.height
const DOT_POOL = 5
const ARC_POOL = 6

export interface AgentFaceProps {
  /** duya run status; defaults to a sleeping tile. */
  status?: AgentFaceStatus
  /** Explicit engine state; overrides the status mapping (catalog animations). */
  state?: StateId
  /** Rest-mood override; visible on states that wear the rest face. */
  expression?: ExpressionId
  /** Rendered height in px; width follows the 1.2 tile ratio. Default 20. */
  size?: number
  /** Body color (bloub "ink"); pick from AGENT_FACE_COLORS by avatarIndex. */
  color?: string
  /**
   * Eye paint color, drawn ON TOP of the body (grok parity: white eyes).
   * The eyes stay readable on any surface this way. Pass 'transparent' to
   * fall back to punched holes showing the surface behind.
   */
  eyeFill?: string
  /**
   * Backing fill behind the body, showing through the eye holes when
   * eyeFill is transparent. Transparent by default.
   */
  paper?: string
  className?: string
}

/**
 * Animated agent avatar: bloub's morphing character engine wearing a fixed
 * duya superellipse tile. One engine instance per face, one shared rAF clock
 * for all faces; frames are applied straight to SVG attributes through refs,
 * so nothing here re-renders React while animating.
 *
 * Two animation layers ride on the engine:
 *  - whole-face motion per status (grok MOTION-table parity: bob + tilt),
 *    which is what makes the face read as alive at 20-32px;
 *  - the engine's own idle life (blink, gaze wander, breath).
 */
export function AgentFace({
  status = 'pending',
  state,
  expression,
  size = 20,
  color = AGENT_FACE_COLORS[0],
  eyeFill = '#ffffff',
  paper = 'transparent',
  className
}: AgentFaceProps) {
  const uid = useId().replace(/:/g, '')
  const maskId = `af-mask-${uid}`

  const svgRef = useRef<SVGSVGElement>(null)
  const engineRef = useRef<BotEngine | null>(null)
  const motionGRef = useRef<SVGGElement>(null)
  const bodyGRef = useRef<SVGGElement>(null)
  const paperRef = useRef<SVGPathElement>(null)
  const maskBodyRef = useRef<SVGPathElement>(null)
  const inkRef = useRef<SVGRectElement>(null)
  const eyeRefs = [useRef<SVGPathElement>(null), useRef<SVGPathElement>(null)]
  const frontCircleRefs = useRef<Array<SVGCircleElement | null>>([])
  const frontPathRef = useRef<SVGPathElement>(null)
  const backCircleRefs = useRef<Array<SVGCircleElement | null>>([])
  const backPathRef = useRef<SVGPathElement>(null)
  const frontDotsRef = useRef<SVGGElement>(null)
  const backDotsRef = useRef<SVGGElement>(null)
  const arcFrontRefs = useRef<Array<SVGPathElement | null>>([])
  const arcBackRefs = useRef<Array<SVGPathElement | null>>([])
  const arcGradRefs = useRef<Array<SVGLinearGradientElement | null>>([])
  const notifRef = useRef<SVGCircleElement>(null)
  const maskNotchRef = useRef<SVGCircleElement>(null)
  // mount-only tick reads driver state through refs so prop changes apply live
  const motionRef = useRef(FACE_MOTION[status])
  useEffect(() => {
    motionRef.current = FACE_MOTION[status]
  }, [status])
  const lifeRef = useRef({ status, explicitExpression: expression })
  useEffect(() => {
    lifeRef.current = { status, explicitExpression: expression }
    // status flips re-arm the life driver on the new cadence
    dartRef.current.nextAt = 0
    morphRef.current.nextAt = 0
    morphRef.current.backAt = 0
  }, [status, expression])
  const dartRef = useRef({ nextAt: 0 })
  const morphRef = useRef({ nextAt: 0, backAt: 0 })

  useEffect(() => {
    const engine = new BotEngine(
      AGENT_FACE_SCALE,
      state ?? STATUS_TO_STATE[status],
      AGENT_FACE_RADII,
      EXPRESSION_BY_ID.get(expression ?? STATUS_TO_EXPRESSION[status]) ?? null
    )
    engineRef.current = engine

    const setAttrs = (el: Element | null, attrs: Record<string, string | number>) => {
      if (!el) return
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    }

    // One dot pool per z-order group; only the active group is displayed.
    const applyDotPool = (
      circleEls: Array<SVGCircleElement | null>,
      pathEl: SVGPathElement | null,
      frame: BotFrame,
      color: string
    ) => {
      for (let k = 0; k < DOT_POOL; k++) {
        const circle = circleEls[k]
        if (!circle) continue
        const dot = frame.dots[k]
        if (!dot || dot.d) {
          circle.setAttribute('opacity', '0')
          continue
        }
        // depth haze: particles fading into the background dim toward it
        const dim = dot.depth === undefined ? 1 : 0.35 + 0.65 * dot.depth
        setAttrs(circle, {
          cx: dot.x,
          cy: dot.y,
          r: dot.r,
          fill: dot.color ?? color,
          opacity: dot.opacity * dim
        })
      }
      if (!pathEl) return
      const tear = frame.dots.find((d) => d.d)
      if (!tear) {
        pathEl.setAttribute('opacity', '0')
        return
      }
      setAttrs(pathEl, {
        d: tear.d ?? '',
        transform: `translate(${tear.x} ${tear.y}) rotate(${tear.rot ?? 0})`,
        fill: tear.color ?? color,
        opacity: tear.opacity
      })
    }

    const applyFrame = (frame: BotFrame) => {
      const bodyG = bodyGRef.current
      const paper = paperRef.current
      const maskBody = maskBodyRef.current
      const ink = inkRef.current
      if (!bodyG || !paper || !maskBody || !ink) return

      paper.setAttribute('d', frame.bodyPath)
      maskBody.setAttribute('d', frame.bodyPath)
      bodyG.setAttribute('opacity', String(frame.bodyAlpha))

      for (let i = 0; i < 2; i++) {
        const rendered = frame.eyes[i]
        const dom = eyeRefs[i].current
        if (!dom) continue
        if (!rendered) {
          dom.setAttribute('opacity', '0')
          continue
        }
        setAttrs(dom, {
          d: rendered.d,
          transform: rendered.matrix,
          fill: eyeFill,
          opacity: rendered.alpha
        })
      }

      const activeDots = frame.dotsBehind ? backDotsRef.current : frontDotsRef.current
      const idleDots = frame.dotsBehind ? frontDotsRef.current : backDotsRef.current
      idleDots?.setAttribute('display', 'none')
      activeDots?.setAttribute('display', '')
      applyDotPool(
        frame.dotsBehind ? backCircleRefs.current : frontCircleRefs.current,
        frame.dotsBehind ? backPathRef.current : frontPathRef.current,
        frame,
        color
      )

      for (let k = 0; k < ARC_POOL; k++) {
        const front = arcFrontRefs.current[k]
        const back = arcBackRefs.current[k]
        const grad = arcGradRefs.current[k]
        if (!front || !back || !grad) continue
        const arc = frame.arcs[k]
        if (!arc) {
          front.setAttribute('visibility', 'hidden')
          back.setAttribute('visibility', 'hidden')
          continue
        }
        setAttrs(front, {
          visibility: '',
          d: arc.front,
          'stroke-width': arc.width,
          opacity: arc.opacity
        })
        setAttrs(back, {
          visibility: '',
          d: arc.back,
          'stroke-width': arc.width,
          opacity: arc.opacity
        })
        setAttrs(grad, {
          x1: arc.grad.x1,
          y1: arc.grad.y1,
          x2: arc.grad.x2,
          y2: arc.grad.y2
        })
        const stops = grad.querySelectorAll('stop')
        arc.grad.stops.forEach((hex, s) => {
          stops[s]?.setAttribute('stop-color', hex)
        })
      }

      const notif = notifRef.current
      const notch = maskNotchRef.current
      if (notif && notch) {
        if (!frame.notif || !frame.notch) {
          notif.setAttribute('visibility', 'hidden')
          notch.setAttribute('visibility', 'hidden')
        } else {
          setAttrs(notif, {
            visibility: '',
            cx: frame.notif.x,
            cy: frame.notif.y,
            r: frame.notif.r
          })
          setAttrs(notch, {
            visibility: '',
            cx: frame.notch.x,
            cy: frame.notch.y,
            r: frame.notch.r
          })
        }
      }
    }

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const motionG = motionGRef.current
    // per-face deterministic life cadence, seeded from the stable useId
    let rngSeed = 0x9e3779b9
    for (const ch of uid) rngSeed = (Math.imul(rngSeed ^ ch.charCodeAt(0), 16777619) >>> 0) || 1
    const rng = createRng(rngSeed)

    const tick = (t: number) => {
      // whole-face bob + tilt per status (grok MOTION parity); rotate about
      // the viewBox origin, which is the tile center
      if (motionG && !reducedMotion) {
        const m = motionRef.current
        const bob = Math.sin((t / m.period) * Math.PI * 2) * m.amplitude
        motionG.setAttribute('transform', `translate(0 ${(-bob).toFixed(3)}) rotate(${m.tilt})`)
      }

      // ── life driver: eye darts + pending micro-morphs ──
      // The engine's continuous idle life (drift, breath) is proportionally
      // right but sub-pixel at roster sizes; discrete, scheduled gaze darts
      // and expression flips are what make the face read alive here.
      // rng is per-face deterministic (bloub convention), not crypto.
      const life = lifeRef.current
      const dart = FACE_DART[life.status]
      if (dart && t >= dartRef.current.nextAt) {
        engine.setLook(
          {
            yaw: (rng() * 2 - 1) * dart.yaw,
            pitch: (rng() * 2 - 1) * dart.pitch,
            mix: 1,
            spin: 0,
            wander: 1
          },
          t,
          0.32
        )
        dartRef.current.nextAt = t + dart.minEvery + rng() * (dart.maxEvery - dart.minEvery)
      }
      // a sleeping tile briefly wakes up and changes its expression, so the
      // roster shows faces at different moments of the same rhythm
      const morphs = life.status === 'pending' && !life.explicitExpression
      if (morphs) {
        const morph = morphRef.current
        if (morph.backAt && t >= morph.backAt) {
          engine.setExpression(EXPRESSION_BY_ID.get('somnolent') ?? null, t)
          morph.backAt = 0
        }
        if (t >= morph.nextAt) {
          engine.setExpression(EXPRESSION_BY_ID.get('neutre') ?? null, t)
          morph.backAt = t + 1.1 + rng() * 0.9
          morph.nextAt = t + 6 + rng() * 4
        }
      }

      applyFrame(engine.sample(t))
    }

    // first frame immediately, then hand over to the shared clock
    tick(faceClockNow())
    let unsubscribe: (() => void) | null = subscribeFaceClock(tick)

    // offscreen faces leave the clock; they rejoin when scrolled back into view.
    // Environments without IntersectionObserver (jsdom tests, old webviews)
    // just stay on the clock.
    let onScreen = true
    let cleanupIO: (() => void) | null = null
    const sync = () => {
      if (onScreen && !unsubscribe) unsubscribe = subscribeFaceClock(tick)
      else if (!onScreen && unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
    if (typeof IntersectionObserver === 'function' && svgRef.current) {
      const io = new IntersectionObserver((entries) => {
        onScreen = entries[0]?.isIntersecting ?? true
        sync()
      })
      io.observe(svgRef.current)
      sync()
      cleanupIO = () => io.disconnect()
    }

    return () => {
      cleanupIO?.()
      unsubscribe?.()
      unsubscribe = null
      engineRef.current = null
    }
    // engine lifecycle is mount-only; status/expression changes go through setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // motion params follow status without remounting the engine
  useEffect(() => {
    engineRef.current?.setState(state ?? STATUS_TO_STATE[status], faceClockNow())
  }, [state, status])

  useEffect(() => {
    const expr = EXPRESSION_BY_ID.get(expression ?? STATUS_TO_EXPRESSION[status]) ?? null
    engineRef.current?.setExpression(expr, faceClockNow())
  }, [expression, status])

  return (
    <svg
      aria-hidden
      className={className}
      width={(size * VB_W) / VB_H}
      height={size}
      viewBox={`${-VB_W / 2} ${-VB_H / 2} ${VB_W} ${VB_H}`}
      style={{ overflow: 'visible' }}
      ref={svgRef}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-VB_W} y={-VB_H} width={VB_W * 2} height={VB_H * 2}>
          <path ref={maskBodyRef} fill="#fff" d="" />
          <circle ref={maskNotchRef} fill="#000" visibility="hidden" />
        </mask>
        {Array.from({ length: ARC_POOL }, (_, k) => (
          <linearGradient key={k} id={`af-ag-${uid}-${k}`} gradientUnits="userSpaceOnUse">
            <stop offset="0" />
            <stop offset="0.5" />
            <stop offset="1" />
          </linearGradient>
        ))}
      </defs>

      <g ref={motionGRef}>
        {/* back decor: burst particles and the rear half of orbit rings */}
        <g ref={backDotsRef} display="none">
          {Array.from({ length: DOT_POOL }, (_, k) => (
            <circle key={k} ref={(el) => void (backCircleRefs.current[k] = el)} opacity={0} />
          ))}
          <path ref={backPathRef} opacity={0} />
        </g>
        {Array.from({ length: ARC_POOL }, (_, k) => (
          <path
            key={`b${k}`}
            ref={(el) => void (arcBackRefs.current[k] = el)}
            fill="none"
            stroke={`url(#af-ag-${uid}-${k})`}
            strokeLinecap="round"
            visibility="hidden"
          />
        ))}

        {/* body: paper backing under an ink rect masked to body-minus-notch */}
        <g ref={bodyGRef}>
          <path ref={paperRef} fill={paper} d="" />
          <g mask={`url(#${maskId})`}>
            <rect ref={inkRef} x={-VB_W} y={-VB_H} width={VB_W * 2} height={VB_H * 2} fill={color} />
          </g>
        </g>

        {/* eyes painted on top (grok parity) — readable on any surface */}
        <path ref={eyeRefs[0]} fill={eyeFill} opacity={0} />
        <path ref={eyeRefs[1]} fill={eyeFill} opacity={0} />

        {/* front decor */}
        {Array.from({ length: ARC_POOL }, (_, k) => (
          <path
            key={`f${k}`}
            ref={(el) => void (arcFrontRefs.current[k] = el)}
            fill="none"
            stroke={`url(#af-ag-${uid}-${k})`}
            strokeLinecap="round"
            visibility="hidden"
          />
        ))}
        <g ref={frontDotsRef}>
          {Array.from({ length: DOT_POOL }, (_, k) => (
            <circle key={k} ref={(el) => void (frontCircleRefs.current[k] = el)} opacity={0} />
          ))}
          <path ref={frontPathRef} opacity={0} />
        </g>
        <circle ref={notifRef} fill={NOTIF_BLUE} visibility="hidden" />
      </g>
    </svg>
  )
}
