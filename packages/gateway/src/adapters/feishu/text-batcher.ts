/**
 * Feishu Text Batcher
 *
 * 把同一 chatId 短时间内连续到达的文本消息合并为单次发送。
 * 飞书客户端常在 ~4000 字符边界拆条发送,本 batcher 把它们拼成一条。
 *
 * 内部基于 ScopedQueue 实现,获得 block / unblock 语义——
 * Agent run 期间禁用防抖 flush(避免 run 还没回用户就被新消息抢答),
 * run 结束后重新 arm quiet window。
 *
 * 对外保持向后兼容的 API:`enqueue / clear / stop / pendingCount`。
 */

import type { FeishuBatchText } from './types.js';
import { ScopedQueue, type QueuedMessage } from './scoped-queue.js';

const DEFAULT_DELAY_MS = 600;

interface TextBatcherOptions {
  /** Last-message 后到 flush 的延迟(默认 600ms)。 */
  delayMs?: number;
}

export class TextBatcher {
  private readonly queue: ScopedQueue<FeishuBatchText>;

  constructor(
    private readonly onFlush: (batches: FeishuBatchText[]) => Promise<void>,
    options: TextBatcherOptions = {},
  ) {
    this.queue = new ScopedQueue<FeishuBatchText>(
      options.delayMs ?? DEFAULT_DELAY_MS,
      (scope, batch) => {
        void this.onFlush(batch);
      },
    );
  }

  /**
   * 累积一条消息到 chatId 队列。若该 chatId 处于 block 状态,
   * 消息只入队不触发 flush。
   */
  enqueue(batch: FeishuBatchText): void {
    this.queue.push(batch.chatId, batch);
  }

  /**
   * 命令直通场景:丢弃该 chatId 此前累积的待 flush 消息。
   * 返回被丢弃的原始消息列表(便于日志/统计)。
   */
  cancel(chatId: string): FeishuBatchText[] {
    return this.queue.cancel(chatId);
  }

  /** Agent run 开始:暂停该 chatId 的防抖 flush,新消息继续累积。 */
  block(chatId: string): void {
    this.queue.block(chatId);
  }

  /**
   * Agent run 结束:恢复该 chatId 的防抖 flush。
   * 若期间累积了消息,arm 一个全新的 quiet window。
   */
  unblock(chatId: string): void {
    this.queue.unblock(chatId);
  }

  /** 该 chatId 是否还有待 flush 的消息。 */
  hasPending(chatId: string): boolean {
    return this.queue.hasPending(chatId);
  }

  /** 清空所有 chatId 的队列与 block 标记。 */
  clear(): void {
    this.queue.cancelAll();
  }

  get pendingCount(): number {
    return this.queue.totalPending();
  }

  stop(): void {
    this.clear();
  }
}

// re-export for direct access if needed
export type { QueuedMessage };
