/**
 * BloubOrb — React client for the ported bloub bot engine.
 *
 * Port of `src/components/BloubBot.vue` from the bloub project. The engine in
 * `./` (math, shape, face, states, engine…) is copied verbatim — it is a pure
 * function of time, so all this component does is run a rAF clock and bind
 * `engine.sample(t)` to SVG attributes.
 *
 * What was deliberately left out of the port:
 *   - the timeline editor models (`block` / `playing` / `elapsed` v-models,
 *     `cycles.ts`, `seek` / `rendAt`) — duya has no editor;
 *   - the i18n `aria-label` — replaced by a literal;
 *   - the export machinery (`frozenAt`, capture, GIF/MP4).
 *
 * Kept: the rAF clock with a bounded delta, the `<mask>` eye holes, the
 * front/back split of the orbit arcs, and the opaque `paper` backing behind the
 * body (without it, arcs passing behind the ball reappear inside the eyes).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { useOrbMood } from '../hooks/useOrbMood';
import { NOTIF_VIOLET } from './decor';
import { BotEngine, type BotFrame } from './engine';
import type { ExpressionId } from './expressions';
import type { PointerSample } from './pointer-mood';
import { RAYON } from './repere';
import {
  COLOR_BY_ID,
  DEFAULT_COLOR,
  DEFAULT_SHAPE,
  SHAPE_BY_ID,
  mixHex,
} from './skins';
import { STATE_BY_ID, type StateId } from './states';

const R = RAYON;

/**
 * Half-side of the viewBox. bloub ships 158 to leave room for the orbit rings
 * (which reach 1.4 R = 140). The duya orb is a 50px ball and only ever shows
 * `idle` / `thinking`, whose geometry stays under ~1.1 R, so we crop tighter to
 * keep the creature from being swallowed by the margin — the same trick as
 * bloub's own favicon. Raise it if a ring-bearing state (`orbit`, `comet`,
 * `play`) is ever used here.
 */
const DEFAULT_HALF = 112;

/** 瞬时动画请求：key 变化即重播一次，播完自动回落到 base 态。 */
export interface OrbMoment {
  state: StateId;
  key: number;
}

export interface BloubOrbProps {
  /** Rendered size in CSS px. The orb stylesheet overrides this to 100%. */
  size?: number;
  /** Bot state to play. See `states.ts` for the catalogue. */
  state?: StateId;
  /** Half-side of the viewBox, in engine units (body radius = 100). */
  half?: number;
  /** Body colour id from `skins.ts`. */
  color?: string;
  /** Shape id from `skins.ts`. */
  shape?: string;
  /**
   * Colour painted behind the body. The eyes are real holes, so this is what
   * shows through them — it must match whatever sits behind the ball or the
   * eye sockets read as a differently coloured patch.
   */
  paper?: string;
  className?: string;
  /** Stop the rAF loop (thumbnails, hidden windows). */
  frozen?: boolean;
  /**
   * 显式表情，覆盖指针情绪（见 `useOrbMood`）。缺省为 null = 指针驱动。
   * 注意：表情只在 `baseFace: true` 的状态生效，目前只有 `idle` / `swirl`。
   */
  expression?: ExpressionId | null;
  /**
   * 指针相对悬浮窗的归一化位置。提供后，`idle` 状态会按 `pointer-mood.ts`
   * 的罗盘分区切换表情，让小怪物"看"向指针所在的方向。
   */
  pointer?: PointerSample | null;
  /**
   * 瞬时动画（moment 层，仲裁器最高优先级）：`key` 变化时播放一次
   * `moment.state`，持续状态目录里的时长后自动回落到 `state`（base 层）。
   * 引擎按时间采样，moment 不需要额外循环——只是一个 setTimeout。
   */
  moment?: OrbMoment | null;
  /**
   * 采样上限（fps）。引擎是纯时间函数，降帧只影响平滑度不影响正确性，
   * 所以空闲态降到 30、睡觉降到 8 都是免费的省电。
   */
  fps?: number;
}

export function BloubOrb({
  size = 50,
  state = 'idle',
  half = DEFAULT_HALF,
  color = DEFAULT_COLOR,
  shape = DEFAULT_SHAPE,
  paper = '#f3eeff',
  className,
  frozen = false,
  expression = null,
  pointer = null,
  moment = null,
  fps = 60,
}: BloubOrbProps) {
  // useId() contains ':' which is not valid inside url(#…).
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const maskId = `orb-bot-mask-${uid}`;

  const shapeRadii = SHAPE_BY_ID.get(shape)?.radii ?? null;
  const ink = COLOR_BY_ID.get(color)?.hex ?? '#7c3aed';

  const engine = useMemo(
    () => new BotEngine(R, state, shapeRadii, null),
    // Engine identity must outlive state changes — `setState` drives it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clock = useRef(0);
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(0));

  // 指针分区 → 表情。三层：显式 > 指针分区（迟滞）> 指针跑远时自由情绪。
  useOrbMood(engine, clock, pointer, expression);

  useEffect(() => {
    engine.setState(state, clock.current);
  }, [engine, state]);

  // Moment 层：key 变化播一次 moment.state，目录时长耗尽后回落 base。
  // 声明在 base effect 之后，同一轮渲染里 moment 后入引擎、必然覆盖 base；
  // setState 幂等（同态直接返回），所以回落调用无害。
  const momentState = moment?.state ?? null;
  const momentKey = moment?.key ?? 0;
  const baseRef = useRef(state);
  baseRef.current = state;
  useEffect(() => {
    if (!momentState) return;
    const durationMs = (STATE_BY_ID.get(momentState)?.duration ?? 2) * 1000;
    engine.setState(momentState, clock.current);
    const timer = setTimeout(() => {
      engine.setState(baseRef.current, clock.current);
    }, durationMs);
    return () => clearTimeout(timer);
  }, [momentKey, momentState, engine]);

  useEffect(() => {
    if (frozen) return;
    let raf = 0;
    let last = 0;
    let lastPaint = 0;
    const minFrameMs = 1000 / fps;
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      // Bounded delta: rAF is suspended while the window is hidden, and an
      // unbounded jump would fast-forward the animation on return.
      const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0;
      last = ms;
      clock.current += dt;
      // fps cap: the engine samples by time, so a skipped paint loses
      // nothing — the next painted frame interpolates to the same pose.
      if (ms - lastPaint < minFrameMs - 1) return;
      lastPaint = ms;
      setFrame(engine.sample(clock.current));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, frozen, fps]);

  /** A dot is a plain disc unless the state supplies a `d` (the "!" teardrop). */
  const dotAttrs = (dot: BotFrame['dots'][number]) => {
    const fill =
      dot.color ??
      (dot.depth === undefined ? ink : mixHex(paper, ink, dot.depth));
    const common = { fill, opacity: dot.opacity };
    return dot.d
      ? {
          ...common,
          d: dot.d,
          transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${R})`,
        }
      : { ...common, cx: dot.x, cy: dot.y, r: dot.r };
  };

  const renderDots = (keyPrefix: string) =>
    frame.dots.map((dot, i) => {
      const attrs = dotAttrs(dot);
      return dot.d ? (
        <path key={`${keyPrefix}${i}`} {...attrs} />
      ) : (
        <circle key={`${keyPrefix}${i}`} {...attrs} />
      );
    });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
      className={className}
      role="img"
      aria-label="Duya 吉祥物"
    >
      <defs>
        {/* The eyes are holes punched through the body, not white shapes laid
            on top, so the silhouette crops them by itself at the edges. */}
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={-half}
          y={-half}
          width={half * 2}
          height={half * 2}
        >
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, i) => (
            <path
              key={i}
              d={eye.d}
              transform={eye.matrix}
              opacity={eye.alpha}
              fill="#000"
            />
          ))}
          {frame.notch && (
            <circle
              cx={frame.notch.x}
              cy={frame.notch.y}
              r={frame.notch.r}
              fill="#000"
            />
          )}
        </mask>

        {frame.arcs.map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${uid}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((c, i) => (
              <stop
                key={i}
                offset={i / Math.max(1, arc.grad.stops.length - 1)}
                stopColor={c}
              />
            ))}
          </linearGradient>
        ))}
      </defs>

      {/* Back half of the orbits — drawn before the body, so it is occluded. */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`b${arc.id}`}
            d={arc.back}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>

      {/* Burst particles pass behind the core. */}
      {frame.dotsBehind && <g>{renderDots('pb')}</g>}

      <g opacity={frame.bodyAlpha}>
        {/* Opaque backing in the exact shape of the body: without it, an arc
            sweeping behind the ball would reappear inside the eye holes. */}
        <path d={frame.bodyPath} fill={paper} />
        <g mask={`url(#${maskId})`}>
          <rect
            x={-half}
            y={-half}
            width={half * 2}
            height={half * 2}
            fill={ink}
          />
        </g>
      </g>

      {!frame.dotsBehind && <g>{renderDots('pf')}</g>}

      {frame.notif && (
        <circle
          cx={frame.notif.x}
          cy={frame.notif.y}
          r={frame.notif.r}
          fill={NOTIF_VIOLET}
        />
      )}

      {/* Front half of the orbits. */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`f${arc.id}`}
            d={arc.front}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>
    </svg>
  );
}
