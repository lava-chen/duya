/**
 * pointer-mood.ts — 指针位置 → 表情方向 / 距离分层 / 头部朝向。
 *
 * 两层模型：
 *   1. **方向**：每个表情的头部朝向各不相同（`expressions.ts` 的 gaze yaw/pitch，
 *      pitch>0 朝上、yaw>0 朝右）。把悬浮窗周围按罗盘方向切成区域，每个区域配
 *      一个脸正好朝那个方向的表情。
 *   2. **距离**：光标离窗口越近，互动越"积极"——近距离切到更活泼的表情池
 *      （大眼睛的 surpris/excite/curieux），眼神也更死盯着你（`mix` 更高）。
 *
 * 本模块是纯函数，不碰 IPC / DOM，方便测试和复用。
 */
import type { ExpressionId } from './expressions';

/**
 * 来自主进程的指针样本：
 *   dx, dy ∈ 归一化相对位置（相对窗口中心，单位=窗口宽高），+x 向右，+y 向下
 *   inside 光标物理上落在窗口内部
 *   dist   光标到窗口中心的绝对距离（px）——距离分层用这个，和窗口大小无关
 */
export interface PointerSample {
  dx: number;
  dy: number;
  inside: boolean;
  dist: number;
  /** 光标相对窗口中心的像素偏移（右/下为正）。眼神跟随的尺度用这个。 */
  ox: number;
  oy: number;
}

/** 罗盘方向 + 远场 */
export type MoodRegion =
  | 'nw' | 'n' | 'ne'
  | 'w' | 'c' | 'e'
  | 'sw' | 's' | 'se'
  | 'away';

/** 距离分层：贴近 / 靠近 / 远处 / 跑远 */
export type Proximity = 'inside' | 'near' | 'far' | 'away';

/** 进入"积极"互动的距离（px）：光标到这里就开始来戏了 */
export const NEAR_RADIUS = 140;
/** 超过这个距离（px）视为"人走远了"，进入自由情绪模式 */
export const AWAY_RADIUS = 320;
/** 判为"横向/纵向偏离"的阈值（窗口宽度的 35%） */
export const REGION_THRESHOLD = 0.35;

export function proximityOf(p: PointerSample): Proximity {
  if (p.inside) return 'inside';
  if (p.dist <= NEAR_RADIUS) return 'near';
  if (p.dist <= AWAY_RADIUS) return 'far';
  return 'away';
}

export function regionForPointer(p: PointerSample): MoodRegion {
  if (p.inside) return 'c';
  if (p.dist > AWAY_RADIUS) return 'away';
  const x = p.dx < -REGION_THRESHOLD ? 'w' : p.dx > REGION_THRESHOLD ? 'e' : 'c';
  const y = p.dy < -REGION_THRESHOLD ? 'n' : p.dy > REGION_THRESHOLD ? 's' : 'c';
  // 单轴居中 → 纯方向；两轴都偏 → 斜角；都居中 → 中心。
  if (x === 'c') return y as MoodRegion;
  if (y === 'c') return x as MoodRegion;
  return (y + x) as MoodRegion;
}

export interface MoodEntry {
  region: MoodRegion;
  /** 主表情：脸的朝向要大致指向这个区域 */
  expression: ExpressionId;
  /** 候选表情：同区域下随机换着来，避免总是一张脸 */
  alternates?: ExpressionId[];
  /**
   * 近距离（near/inside）的"积极"表情池：光标靠近时换上更活泼、眼睛更大的脸。
   * 缺省则退回主表情池。
   */
  near?: ExpressionId[];
}

/**
 * 区域 + 距离 → 表情。选择依据是 `expressions.ts` 里每个表情的 gaze(yaw, pitch)：
 *
 *   ne  → neutre   (yaw +28, pitch +28)  右上
 *   n   → hilare   (yaw +4,  pitch +14)  上（大笑）
 *   nw  → confus   (yaw -14, pitch +3)   左上
 *   e   → curieux  (yaw +16, pitch -9)   右
 *   c   → attentif / curieux             居中
 *   w   → blase    (yaw -22, pitch +2)   左
 *   se  → curieux  (yaw +16, pitch -9)   右下
 *   s   → triste   (yaw +3,  pitch -13)  下
 *   sw  → timide   (yaw -19, pitch -14)  左下
 *   away→ neutre                          指针跑远
 *
 * `near` 池则是近距离的"来戏"版本：大眼睛、歪头、盯着看。
 */
export const MOODS: MoodEntry[] = [
  {
    region: 'ne',
    expression: 'neutre',
    alternates: ['fier', 'heureux'],
    near: ['excite', 'heureux', 'fier'],
  },
  {
    region: 'n',
    expression: 'hilare',
    alternates: ['heureux', 'surpris'],
    near: ['heureux', 'excite', 'surpris'],
  },
  {
    region: 'nw',
    expression: 'confus',
    alternates: ['mefiant'],
    near: ['confus', 'curieux', 'mefiant'],
  },
  {
    region: 'e',
    expression: 'curieux',
    alternates: ['mefiant'],
    near: ['curieux', 'excite', 'mefiant'],
  },
  {
    region: 'c',
    expression: 'attentif',
    alternates: ['curieux'],
    near: ['surpris', 'curieux', 'excite'],
  },
  {
    region: 'w',
    expression: 'blase',
    alternates: ['confus'],
    near: ['mefiant', 'confus', 'curieux'],
  },
  {
    region: 'se',
    expression: 'curieux',
    alternates: ['somnolent'],
    near: ['curieux', 'excite', 'somnolent'],
  },
  {
    region: 's',
    expression: 'triste',
    alternates: ['somnolent'],
    near: ['surpris', 'triste', 'somnolent'],
  },
  {
    region: 'sw',
    expression: 'timide',
    alternates: ['triste'],
    near: ['timide', 'triste', 'confus'],
  },
  { region: 'away', expression: 'neutre' },
];

export const MOOD_BY_REGION = new Map<string, MoodEntry>(
  MOODS.map((m) => [m.region, m]),
);

/**
 * 区域 + 距离 → 表情 id。近距离优先用 `near` 池，其余用主池随机挑一个，
 * 让同一个方向的戏份有变化。未知区域兜底 neutre。
 */
export function expressionForRegion(
  region: MoodRegion,
  proximity: Proximity = 'far',
): ExpressionId {
  const entry = MOOD_BY_REGION.get(region);
  if (
    entry &&
    entry.near &&
    entry.near.length > 0 &&
    (proximity === 'near' || proximity === 'inside')
  ) {
    return entry.near[Math.floor(Math.random() * entry.near.length)]!;
  }
  const pool = entry
    ? [entry.expression, ...(entry.alternates ?? [])]
    : ['neutre' as ExpressionId];
  return pool[Math.floor(Math.random() * pool.length)] ?? 'neutre';
}

/**
 * 眼神跟随的尺度参数，取自 bloub 验证过的 `src/ui/gaze.ts`：
 * 归一化参考半径、最大转角、以及光标居中时略高于赤道的注视锚点。
 * 早期实现把偏移除以 50px 窗口再乘 45°，光标离开球 65px 就打满 ±60°，
 * 眼睛长期钉在球体边缘的极限角——观感就是"方向不对、死盯一边"。
 */
export const GAZE_REF_PX = 320;
export const GAZE_YAW_MAX = 16;
export const GAZE_PITCH_MAX = 13;
export const GAZE_PITCH_REST = 10;

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), max);

/**
 * 指针方向 → 头部朝向（度）。像素偏移以 GAZE_REF_PX 归一到 ±1：
 * 光标右 → yaw 正（引擎约定 yaw>0 看屏幕右），光标下 → pitch 从锚点
 * 往下减（pitch>0 看屏幕上）。
 */
export function lookFromPointer(p: PointerSample): { yaw: number; pitch: number } {
  const nx = clamp(p.ox / GAZE_REF_PX, -1, 1);
  const ny = clamp(p.oy / GAZE_REF_PX, -1, 1);
  return {
    yaw: nx * GAZE_YAW_MAX,
    pitch: GAZE_PITCH_REST - ny * GAZE_PITCH_MAX,
  };
}

/**
 * 距离越近看得越"死盯着你"：返回给 `setLook` 的 mix（0 = 完全用表情自己的
 * 朝向，1 = 完全看向指针）。贴近时 0.9，靠近时 0.75，远处 0.5。
 */
export function lookMixForProximity(p: PointerSample): number {
  switch (proximityOf(p)) {
    case 'inside':
      return 0.9;
    case 'near':
      return 0.75;
    default:
      return 0.5;
  }
}
