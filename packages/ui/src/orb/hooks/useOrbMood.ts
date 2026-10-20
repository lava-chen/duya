/**
 * useOrbMood — 把指针位置接上 BotEngine 的表情与视线。
 *
 * 三层优先级（高 → 低）：
 *   1. `explicit` 显式表情（外部指定情绪时直接用，覆盖一切）；
 *   2. 指针在附近 → 视线持续跟随光标（`setLook`，距离越近 mix 越高），
 *      并按罗盘分区 + 距离分层切换表情：
 *        - 近距离（<140px）用"积极"表情池（大眼睛 surpris/excite/curieux），
 *        - 远处用分区表情（带 160ms 迟滞防抖），
 *        - 贴近窗口时更是直接盯着你看（mix 0.9）；
 *   3. 指针跑远 → 自由情绪模式：每隔几秒随机来一个"小表情"
 *      （困了、犯懒、好奇…）呆一小会儿再回到 neutre，闲着也不单调。
 *
 * 所有切换都走引擎的时间戳 setter（`setExpression` / `setLook`），自带
 * easeOutQuint 插值，所以每一个动作都是"滑过去"的，不是硬切。
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

import { BotEngine } from '../bot/engine';
import { EXPRESSION_BY_ID, type ExpressionId } from '../bot/expressions';
import {
  expressionForRegion,
  lookFromPointer,
  lookMixForProximity,
  proximityOf,
  regionForPointer,
  type PointerSample,
} from '../bot/pointer-mood';

/** 指针在一个新区域内停留够久才切换（迟滞窗口） */
const REGION_HOLD_MS = 160;
/** 自由情绪池（都挺"闲"的，不会吓人） */
const FREE_POOL: ExpressionId[] = [
  'neutre',
  'somnolent',
  'blase',
  'curieux',
  'heureux',
];
const FREE_MIN_GAP = 2200;
const FREE_MAX_GAP = 5600;
/** 眼神跟随时的残余生命感：0.2 倍漂移，别跟目标打架 */
const TRACK_WANDER = 0.2;

function toExpr(id: ExpressionId | null) {
  return id ? (EXPRESSION_BY_ID.get(id) ?? null) : null;
}

export function useOrbMood(
  engine: BotEngine,
  clock: MutableRefObject<number>,
  pointer: PointerSample | null,
  explicit: ExpressionId | null,
): void {
  // 已确认切换到的区域 / 正在候选的区域（迟滞用）
  const committed = useRef<string | null>(null);
  const candidate = useRef<string | null>(null);
  const candSince = useRef(0);
  const freeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 指针是否"跑远"。用 state 而非依赖 pointer 对象：pointer 每 40ms 换个新
  // 引用，若自由情绪 effect 依赖它，定时器会被反复重置，情绪永远不触发。
  const [away, setAway] = useState(true);
  useEffect(() => {
    setAway(!pointer || proximityOf(pointer) === 'away');
  }, [pointer]);

  // 1) 显式表情
  useEffect(() => {
    if (explicit) {
      engine.setExpression(toExpr(explicit), clock.current);
    }
  }, [explicit, engine, clock]);

  // 2a) 视线跟随：指针在附近时，眼睛/头一直朝光标方向滑过去。每次 poll 都
  // 重设目标，引擎从当前值续接（morph 0.24s），所以是连续追逐而非跳变。
  useEffect(() => {
    if (explicit || !pointer || away) {
      engine.setLook(null, clock.current);
      return;
    }
    const { yaw, pitch } = lookFromPointer(pointer);
    engine.setLook(
      {
        yaw,
        pitch,
        mix: lookMixForProximity(pointer),
        spin: 0,
        wander: TRACK_WANDER,
      },
      clock.current,
    );
  }, [pointer, away, explicit, engine, clock]);

  // 2b) 分区 + 距离 → 表情（迟滞切换；近距离直接来戏）
  useEffect(() => {
    if (explicit) return;
    if (!pointer || away) return;

    const region = regionForPointer(pointer);
    const prox = proximityOf(pointer);
    const now = Date.now();

    if (region === committed.current) {
      candidate.current = null;
      return;
    }
    if (region === candidate.current) {
      if (now - candSince.current >= REGION_HOLD_MS) {
        committed.current = region;
        candidate.current = null;
        engine.setExpression(
          toExpr(expressionForRegion(region, prox)),
          clock.current,
        );
      }
      return;
    }
    candidate.current = region;
    candSince.current = now;
  }, [pointer, away, explicit, engine, clock]);

  // 3) 自由情绪模式（指针跑远 / 拿不到指针）
  useEffect(() => {
    if (explicit || !away) return;

    const schedule = () => {
      const gap = FREE_MIN_GAP + Math.random() * (FREE_MAX_GAP - FREE_MIN_GAP);
      freeTimer.current = setTimeout(() => {
        const mood = FREE_POOL[Math.floor(Math.random() * FREE_POOL.length)]!;
        engine.setExpression(toExpr(mood), clock.current);
        schedule();
      }, gap);
    };
    schedule();
    return () => {
      if (freeTimer.current) clearTimeout(freeTimer.current);
    };
  }, [away, explicit, engine, clock]);
}
