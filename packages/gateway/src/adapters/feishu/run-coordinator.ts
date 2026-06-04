/**
 * Per-scope 串行 + 全局并发上限的协调器。
 *
 * 行为契约:
 * - 同一 scope(通常是 chatId 或 chatId:threadId)任一时刻至多一个 active run。
 * - 跨 scope 同时跑的 run 不超过 maxConcurrent;超出时 acquire() 异步等待。
 * - acquire() 返回的 release 函数**必须**在 try/finally 里调用,否则 waiters 永远等不到唤醒。
 *
 * 设计参考 Proma feishu-bridge 的 RunCoordinator,以及 Proma lib/feishu/run-coordinator.ts。
 */

export interface ActiveRunHandle {
  scope: string;
  runId: string;
  startedAt: number;
}

export class RunCoordinator {
  private readonly active = new Map<string, ActiveRunHandle>();
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrent: () => number;

  constructor(maxConcurrent: number | (() => number)) {
    this.maxConcurrent = typeof maxConcurrent === 'function'
      ? maxConcurrent
      : () => maxConcurrent;
  }

  /** 当前 scope 是否已有 active run。 */
  isActive(scope: string): boolean {
    return this.active.has(scope);
  }

  /** 当前活跃的 run 总数(跨 scope)。 */
  size(): number {
    return this.active.size;
  }

  /**
   * 申请并发槽位。
   * 槽位不足时排队等待,先到先得。
   * 同一 scope 已有 run 时也等待(per-scope 串行)。
   *
   * 返回 release 函数,**必须**放在 try/finally 里调用。
   */
  async acquire(scope: string, runId: string): Promise<() => void> {
    // 先等全局槽位,再等 per-scope 槽位。两次 await 是必要的:
    // 第一次释放后,我们可能不是最靠前的 per-scope waiter,需要再让出。
    while (this.active.size >= this.maxConcurrent() || this.active.has(scope)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const handle: ActiveRunHandle = { scope, runId, startedAt: Date.now() };
    this.active.set(scope, handle);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.active.get(scope);
      if (cur && cur.runId === runId) {
        this.active.delete(scope);
      }
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  /**
   * 强制注销某个 scope 的 run(仅清注册表,调用方需自行停止底层任务)。
   * 供未来"用户主动抢占"按钮 / 命令使用,本期未启用。
   */
  abort(scope: string): ActiveRunHandle | undefined {
    const handle = this.active.get(scope);
    if (!handle) return undefined;
    this.active.delete(scope);
    const next = this.waiters.shift();
    if (next) next();
    return handle;
  }

  /** stop 时调用:清空注册表 + 唤醒所有等待者。 */
  abortAll(): ActiveRunHandle[] {
    const handles = [...this.active.values()];
    this.active.clear();
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w();
    }
    return handles;
  }
}
