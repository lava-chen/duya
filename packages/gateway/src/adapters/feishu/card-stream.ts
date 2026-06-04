/**
 * CardKit 2.0 流式卡片:创建一次、按 sequence 增量 update 多次。
 *
 * 设计要点:
 * - 节流(避免高频更新撞飞书 API 限流)
 * - 强制 flush(终态时立刻发送最终态,不被节流推迟)
 * - inFlight 期间用"最后一个胜出"语义合并请求,不丢消息
 *
 * 依赖注入 CardStreamClient 抽象,本类不直接 fetch——这样:
 * - 单元测试可以注入 mock
 * - 后续如切换到 lark.Client.cardkit.v1,只需改 Client 实现,本类不变
 *
 * 设计参考 Proma lib/feishu/card-stream.ts。
 */

const THROTTLE_MS = 400;
const MAX_UPDATE_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 200;

/**
 * 飞书 API 调用的最小抽象。本类不直接 fetch——
 * 由 FeishuChannel 在构造 CardStream 时注入。
 */
export interface CardStreamClient {
  /** 调 open-apis/cardkit/v1/card/create,创建 CardKit 2.0 卡片实例。 */
  createCard(cardJson: object): Promise<string>;
  /** 调 open-apis/cardkit/v1/card/update,按 sequence 增量更新。 */
  updateCard(cardId: string, cardJson: object, sequence: number): Promise<void>;
  /**
   * 把已创建的卡片作为消息发到 chat。
   * replyToMessageId 非空时调 im.message.reply,否则 im.message.create。
   * 返回 message_id,用于后续可能的 reaction / recall。
   */
  sendCardMessage(
    cardId: string,
    chatId: string,
    opts: { replyToMessageId?: string; replyInThread?: boolean },
  ): Promise<string>;
}

export class CardStream {
  private constructor(
    private readonly client: CardStreamClient,
    private readonly cardId: string,
    public readonly messageId: string,
    public readonly chatId: string,
  ) {}

  private sequence = 1;
  private pendingCard: object | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;

  /**
   * 创建 CardKit 2.0 卡片实例 + 把它作为 message 发到指定 chat。
   * 返回的 CardStream 持有 card_id 和 message_id,后续可继续 update。
   */
  static async open(
    client: CardStreamClient,
    chatId: string,
    initialCard: object,
    opts: { replyToMessageId?: string; replyInThread?: boolean } = {},
  ): Promise<CardStream> {
    const cardId = await client.createCard(initialCard);
    const messageId = await client.sendCardMessage(cardId, chatId, opts);
    return new CardStream(client, cardId, messageId, chatId);
  }

  /**
   * 排队一次更新。同步返回,实际请求会在 THROTTLE_MS 后合并发送。
   * 终态时建议调 flush() 强制立刻发送。
   */
  update(card: object): void {
    if (this.closed) return;
    this.pendingCard = card;
    this.scheduleFlush();
  }

  /**
   * 立刻刷新到最新 pending 卡片,等待网络返回。终态必调。
   */
  async flush(card?: object): Promise<void> {
    if (this.closed) return;
    if (card) this.pendingCard = card;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    await this.drain();
  }

  /**
   * 关闭:禁止后续 update,等 in-flight 请求结束。
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
  }

  private scheduleFlush(): void {
    // inFlight 期间不重复设 timer:drain 的 finally 会在请求结束时
    // 检测 pendingCard 并重新触发,保证"最后一个胜出"语义不会丢消息
    if (this.pendingTimer || this.inFlight) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.drain();
    }, THROTTLE_MS);
  }

  private async drain(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
    if (!this.pendingCard || this.closed) return;

    const card = this.pendingCard;
    this.pendingCard = null;
    const seq = this.sequence++;

    this.inFlight = this.sendUpdate(card, seq).finally(() => {
      this.inFlight = null;
      // 若节流期间又积累了新卡,触发下一轮
      if (this.pendingCard && !this.closed) {
        this.scheduleFlush();
      }
    });
    await this.inFlight;
  }

  private async sendUpdate(card: object, sequence: number): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.client.updateCard(this.cardId, card, sequence);
        return;
      } catch (err) {
        attempt++;
        if (attempt > MAX_UPDATE_RETRIES) {
          // eslint-disable-next-line no-console
          console.error('[Feishu CardStream] cardkit.card.update 失败(已达最大重试)', {
            cardId: this.cardId,
            sequence,
            err: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        // 飞书 API 限流时退避后重试
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
      }
    }
  }
}
