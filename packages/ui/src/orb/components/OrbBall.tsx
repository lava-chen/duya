/**
 * OrbBall — DORMANT / LOADING shared ball component.
 *
 * The creature inside is the ported bloub bot engine (`../bot/BloubOrb`),
 * which owns its own rAF clock and drives both the idle liveliness (breathing,
 * gaze drift, blinking) and the state morph. This component maps the orb
 * states onto bot states and keeps the shell interactions:
 *
 *   - DORMANT → `idle`   : breathing blob, eyes wander and blink
 *   - LOADING → `thinking`: body collapses to a dot, three dots pulse
 *   - DORMANT after SLEEP_AFTER_MS with the cursor away → `sleep`
 *
 * Sleep and frame rate are the power levers: a sleeping ball samples at
 * SLEEP_FPS and polls the pointer at 250ms; an awake idle ball paints at
 * 30fps unless the cursor is close (then 60fps for smooth gaze tracking).
 *
 * The outer `.orb-ball` (frosted glass, hover/active, drag) lives in orb.css
 * and is untouched.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { BloubOrb, type OrbMoment } from '../bot/BloubOrb';
import { proximityOf } from '../bot/pointer-mood';
import { useOrbPointer } from '../hooks/useOrbPointer';

/** 光标离开多久后小怪物睡着（只看指针，不看窗口焦点——球是常驻的）。 */
const SLEEP_AFTER_MS = 180_000;
/** 睡觉时的采样帧率：只有慢速 zzz 点，8fps 与 60fps 观感一致。 */
const SLEEP_FPS = 8;
/** 空闲（指针不在附近）的采样帧率。 */
const IDLE_FPS = 30;
/** 指针在附近（眼神跟随中）保持满帧。 */
const ACTIVE_FPS = 60;
/** 睡着时指针轮询降频，唤醒检测仍然有效。 */
const SLEEP_POLL_MS = 250;

interface OrbBallProps {
  onMouseDown?: (e: MouseEvent) => void;
  /** When true, render the LOADING variant (`thinking`). */
  loading?: boolean;
  /** LOADING 的工具执行阶段：`orbit` 环绕动画，需要更宽的 viewBox。 */
  toolStage?: boolean;
  /** 瞬时动画（wink / burst…），由 OrbApp 在业务事件时触发。 */
  moment?: OrbMoment | null;
  /** 点击球的行为（默认打开输入框；OrbApp 传通知分流）。 */
  onActivate?: () => void;
}

export function OrbBall({
  onMouseDown,
  loading = false,
  toolStage = false,
  moment = null,
  onActivate,
}: OrbBallProps) {
  const [sleeping, setSleeping] = useState(false);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseDown = (e: MouseEvent) => {
    onMouseDown?.(e);
  };

  const handleClick = () => {
    setSleeping(false);
    if (loading) return; // LOADING variant doesn't respond to click
    if (onActivate) {
      onActivate();
      return;
    }
    window.electronAPI?.orb?.showInput();
  };

  // idle 时轮询指针位置，驱动表情分区（LOADING 没眼睛，不开）。
  const pointer = useOrbPointer(!loading, sleeping ? SLEEP_POLL_MS : undefined);

  // Sleep: 光标离开（或拿不到指针）SLEEP_AFTER_MS 后睡着；光标靠近即醒。
  useEffect(() => {
    if (loading) {
      setSleeping(false);
      return;
    }
    const near = pointer !== null && proximityOf(pointer) !== 'away';
    if (near) {
      setSleeping(false);
      return;
    }
    if (sleepTimer.current === null) {
      sleepTimer.current = setTimeout(() => {
        sleepTimer.current = null;
        setSleeping(true);
      }, SLEEP_AFTER_MS);
    }
  }, [pointer, loading]);
  useEffect(
    () => () => {
      if (sleepTimer.current) clearTimeout(sleepTimer.current);
    },
    [],
  );

  const fps = sleeping
    ? SLEEP_FPS
    : loading || (pointer !== null && proximityOf(pointer) !== 'away')
      ? ACTIVE_FPS
      : IDLE_FPS;

  return (
    <div
      className="orb-ball orb-drag"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      role="button"
      aria-label="Duya Orb — 点击或双击 Shift+= 唤醒"
    >
      <div className="orb-ball-mascot" aria-hidden="true">
        <BloubOrb
          state={
            sleeping
              ? 'sleep'
              : loading
                ? toolStage
                  ? 'orbit'
                  : 'thinking'
                : 'idle'
          }
          half={toolStage ? 158 : undefined}
          pointer={sleeping ? null : pointer}
          moment={moment}
          fps={fps}
        />
      </div>
    </div>
  );
}
