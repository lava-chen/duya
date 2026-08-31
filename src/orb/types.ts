/**
 * Orb shared types.
 *
 * The IPC contract mirrors electron/preload.ts OrbAPI and the
 * `automation:orb:*` handlers in electron/ipc/orb.ts. Plan 453
 * Task F.
 */

/** Orb 4 态机状态 */
export type OrbState = 'DORMANT' | 'INPUT' | 'LOADING' | 'RESULT';

/** 进度气泡内容(LOADING 状态) */
export interface ProgressInfo {
  /** "思考中" / "正在用 xxx 工具" / null = spinner only */
  label: string | null;
  /** 工具名(可选) — 显示在气泡中 */
  toolName?: string;
  /** 阶段:thinking / tool / finalizing */
  stage?: 'thinking' | 'tool' | 'finalizing';
}

/** Result 卡片内容 */
export interface ResultContent {
  /** 流式累积的 Markdown 原文(用于 Insert Tab 直接 type) */
  rawText: string;
  /** 标题(可选) — 显示在 body 顶部 */
  title?: string;
  /** Stream turn id(用于去重) */
  turnId: string;
}

/** Orb preload API 类型 — mirrors OrbAPI in electron/preload.ts. */
export interface OrbAPI {
  submit: (
    prompt: string,
    attachments?: string[],
  ) => Promise<{ accepted: boolean; note?: string }>;
  showInput: () => Promise<{ ok: boolean }>;
  /** 模型徽标/选择器:model 为当前生效值,options 为可选列表。 */
  chatConfig: () => Promise<{
    model: string | null;
    options: Array<{ providerId: string; label: string; model: string }>;
  }>;
  setModel: (payload: { providerId: string; model: string }) => Promise<{ ok: boolean }>;
  insertTab: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  setPosition: (position: {
    x: number;
    y: number;
    displayId: number;
  }) => Promise<{ ok: boolean }>;
  state: () => Promise<{ state: OrbState }>;
  /** 展开 RESULT 卡片：notify 徽标在先，点击球时调用（窗口长到 350x350）。 */
  openResult: () => Promise<{ ok: boolean }>;
  /** 主进程返回指针相对悬浮窗的归一化位置 + 像素偏移 + 绝对距离；窗口未创建时为 null */
  pointer: () => Promise<{
    dx: number;
    dy: number;
    inside: boolean;
    dist: number;
    ox: number;
    oy: number;
  } | null>;
  collapse: () => Promise<{ ok: boolean }>;
  onChunk: (
    callback: (chunk: { delta: string; turnId: string }) => void,
  ) => () => void;
  onShowInput: (callback: () => void) => () => void;
  onShowLoading: (
    callback: (payload: { stage: string }) => void,
  ) => () => void;
  onUpdateProgress: (
    callback: (payload: { stage: string; label: string }) => void,
  ) => () => void;
  onShowResult: (
    callback: (payload: {
      turnId: string;
      text: string;
      finishedAt: string;
    }) => void,
  ) => () => void;
  /**
   * DORMANT 时结果到达（主进程不想直接弹卡片，先给球挂徽标）。
   * 内容存好，用户点球后再 openResult。
   */
  onNotifyResult: (
    callback: (payload: {
      turnId: string;
      text: string;
      finishedAt: string;
    }) => void,
  ) => () => void;
  onHide: (callback: () => void) => () => void;
}
