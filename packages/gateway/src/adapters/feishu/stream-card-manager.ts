/**
 * 飞书流式卡片编排器。
 *
 * 解决的核心问题:
 * 1. Agent run 的 SDKMessage 流是异步、按帧到达的,需要在飞书侧呈现为一张
 *    持续更新的 CardKit 2.0 卡片(支持 reasoning / tool_use / 文本流式追加)。
 * 2. 同一 chatId 同时只允许一个 active run(per-scope 串行)。
 * 3. 终态必须立刻 flush,不被节流推迟。
 * 4. 飞书侧文本防抖 flush 在 run 期间要 block(避免 run 中新消息抢答),
 *    run 结束后 unblock。
 *
 * 调用方典型用法:
 *   const mgr = new FeishuStreamCardManager(channel);
 *   const streamId = await mgr.startStream(chatId, sessionId, opts);
 *   mgr.feedPayload(streamId, { kind: 'sdk_message', message: ... });
 *   mgr.feedPayload(streamId, { kind: 'sdk_message', message: ... });
 *   await mgr.finishStream(streamId);  // 终态 flush
 *
 * 设计参考 Proma feishu-bridge.ts 的流式卡片分支。
 */

import { CardStream } from './card-stream.js';
import type { FeishuChannel } from './index.js';
import {
  createInitialState,
  finalizeIfRunning,
  markError,
  markInterrupted,
  reduce,
  type AgentStreamPayload,
  type RunState,
} from './card-run-state.js';
import { renderCard, type RenderOptions } from './card-renderer.js';

interface StreamEntry {
  scope: string;
  state: RunState;
  card: CardStream;
  runId: string;
}

export interface StartStreamOptions {
  /** 卡片头部小标题,例如 "@xxx Bot · 工作区 yyy"。 */
  header?: string;
  /** 卡片底部"如何终止"提示。 */
  stopHint?: string;
  /** 回复到某条用户消息(reply 模式);省略则创建新消息。 */
  replyToMessageId?: string;
  /** 是否以 thread reply 形式发送(仅 reply 模式有效)。 */
  replyInThread?: boolean;
  /** 是否展示工具调用块,默认 true。 */
  showToolCalls?: boolean;
}

const HEADER_RUNNING = 'Agent 处理中';
const HEADER_DONE = 'Agent 已完成';

export class FeishuStreamCardManager {
  private readonly streams = new Map<string, StreamEntry>();
  private readonly runReleases = new Map<string, () => void>();
  private nextStreamId = 1;

  constructor(private readonly channel: FeishuChannel) {}

  /** 当前活跃的流数(诊断用)。 */
  get activeCount(): number {
    return this.streams.size;
  }

  /**
   * 启动一个流式卡片。
   * 内部:
   * 1. 申请 RunCoordinator 槽位(per-scope 串行 + 全局上限)
   * 2. block 该 chatId 的文本防抖
   * 3. 创建 CardKit 2.0 卡片并发送,获得 CardStream 句柄
   *
   * 返回 streamId,后续用 feedPayload / finishStream。
   *
   * **必须**在 try/finally 里 finishStream,否则槽位会泄漏。
   */
  async startStream(
    chatId: string,
    sessionId: string,
    opts: StartStreamOptions = {},
  ): Promise<string> {
    const runId = `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runCoordinator = this.channel.getRunCoordinator();
    const release = await runCoordinator.acquire(chatId, runId);

    this.channel.blockChat(chatId);

    const initialState = createInitialState();
    const initialCard = renderCard(initialState, {
      header: opts.header
        ? `${opts.header} · ${HEADER_RUNNING}`
        : HEADER_RUNNING,
      stopHint: opts.stopHint ?? '发送 /stop 可终止当前任务',
      showToolCalls: opts.showToolCalls,
    });

    try {
      const card = await this.channel.createCardStream(chatId, initialCard, {
        replyToMessageId: opts.replyToMessageId,
        replyInThread: opts.replyInThread,
      });

      const streamId = `stream-${this.nextStreamId++}`;
      this.streams.set(streamId, {
        scope: chatId,
        state: initialState,
        card,
        runId,
      });
      this.runReleases.set(streamId, release);
      return streamId;
    } catch (err) {
      // 卡片创建失败也要释放槽位,否则 chatId 永远被锁
      release();
      this.channel.unblockChat(chatId);
      throw err;
    }
  }

  /**
   * 把一个 AgentStreamPayload 推进对应 stream 的 RunState。
   * running 终态用 card.update(节流),终态用 card.flush + close。
   */
  feedPayload(streamId: string, payload: AgentStreamPayload): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    const nextState = reduce(entry.state, payload);
    if (nextState === entry.state) return;

    const isTerminal = nextState.terminal !== 'running';
    const opts: RenderOptions = this.buildRenderOpts(entry, isTerminal);
    const card = renderCard(nextState, opts);

    if (isTerminal) {
      void entry.card
        .flush(card)
        .then(() => entry.card.close())
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[FeishuStreamCard] 终态 flush 失败', { streamId, err });
        });
      // 状态推进后,等 finishStream 显式收尾(release 槽位)
    } else {
      entry.card.update(card);
    }
    entry.state = nextState;
  }

  /**
   * 收尾:终态 flush、释放 CardStream、释放 RunCoordinator 槽位、unblock 文本防抖。
   * 多次调用幂等。
   */
  async finishStream(streamId: string, opts: { error?: string; interrupted?: boolean } = {}): Promise<void> {
    const entry = this.streams.get(streamId);
    if (!entry) return;

    try {
      // 在 flush 之前再 apply 一次终止条件,确保 state 终态正确
      let finalState = entry.state;
      if (opts.error) finalState = markError(finalState, opts.error);
      else if (opts.interrupted) finalState = markInterrupted(finalState);
      else finalState = finalizeIfRunning(finalState);

      const card = renderCard(finalState, this.buildRenderOpts(entry, true));
      await entry.card.flush(card).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[FeishuStreamCard] finishStream flush 失败', { streamId, err });
      });
      await entry.card.close();
    } finally {
      this.streams.delete(streamId);
      const release = this.runReleases.get(streamId);
      if (release) {
        this.runReleases.delete(streamId);
        release();
      }
      this.channel.unblockChat(entry.scope);
    }
  }

  /**
   * 强制中止所有流(用于 channel stop)。
   * 与 finishStream 不同:不等待 flush,直接关闭 + 释放。
   */
  abortAll(): void {
    for (const [streamId, entry] of this.streams) {
      void entry.card.close().catch(() => {});
      this.streams.delete(streamId);
      const release = this.runReleases.get(streamId);
      if (release) {
        this.runReleases.delete(streamId);
        release();
      }
      this.channel.unblockChat(entry.scope);
    }
  }

  private buildRenderOpts(entry: StreamEntry, isTerminal: boolean): RenderOptions {
    // header 已在 startStream 注入;这里只补 stopHint(仅 running 期)
    return {
      stopHint: isTerminal ? undefined : '发送 /stop 可终止当前任务',
    };
  }
}
