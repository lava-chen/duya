/**
 * safe-storage — 永不抛错的本地存储封装。
 *
 * `localStorage` 在四种常见场景下会**抛异常**而不是返回 null：
 *   1. 服务端渲染 / 无 window（duya 的 orb 与部分 story 环境）
 *   2. Safari 隐私模式：存在但写入立即抛 QuotaExceededError
 *   3. 磁盘配额耗尽或被企业策略禁用
 *   4. 第三方 Cookie 被禁时，某些 Electron/嵌入式 WebView 直接禁掉 Storage
 *
 * 存储是"锦上添花的持久化"，不应该是崩溃源。因此这里把探测结果缓存下来，
 * 失败时降级到进程内 Map——当次会话仍然可用（主题、草稿、折叠态不会跳变），
 * 只是重启后不保留。所有导出都不抛错。
 *
 * 用法：用 `readSafeJSON`/`writeSafeJSON` 替代裸 `JSON.parse(localStorage.getItem(...))`。
 */

/** 会话级降级后端：仅在 localStorage 不可用时启用。 */
const memoryFallback = new Map<string, string>();

/** `undefined` = 尚未探测；`null` = 已探测且不可用。 */
let resolvedBackend: Storage | null | undefined;

function resolveBackend(): Storage | null {
  if (resolvedBackend !== undefined) return resolvedBackend;

  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      resolvedBackend = null;
      return resolvedBackend;
    }
    const probe = '__duya_storage_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    resolvedBackend = window.localStorage;
  } catch {
    // 隐私模式 / 配额为 0 / 策略禁用 —— 降级到内存。
    resolvedBackend = null;
  }
  return resolvedBackend;
}

/** 测试与热重载用：丢弃缓存的探测结果。 */
export function resetStorageBackendCache(): void {
  resolvedBackend = undefined;
}

export function readSafeStorage(key: string): string | null {
  const backend = resolveBackend();
  if (backend) {
    try {
      return backend.getItem(key);
    } catch {
      return memoryFallback.get(key) ?? null;
    }
  }
  return memoryFallback.get(key) ?? null;
}

/** 返回是否真的写到了持久层（false 表示只进了内存降级层）。 */
export function writeSafeStorage(key: string, value: string): boolean {
  const backend = resolveBackend();
  if (!backend) {
    memoryFallback.set(key, value);
    return false;
  }
  try {
    backend.setItem(key, value);
    memoryFallback.delete(key);
    return true;
  } catch {
    // 写入失败（配额）——保留在内存里，至少本次会话一致。
    memoryFallback.set(key, value);
    return false;
  }
}

export function removeSafeStorage(key: string): void {
  memoryFallback.delete(key);
  const backend = resolveBackend();
  if (!backend) return;
  try {
    backend.removeItem(key);
  } catch {
    /* 删除失败无需处理：值已不在内存层。 */
  }
}

/**
 * 读取并解析 JSON。`guard` 用于挡住"结构变了但 key 没变"的旧值——
 * 反序列化后先过一遍校验，不合法就当缺失处理，避免脏数据把 UI 带崩。
 */
export function readSafeJSON<T>(
  key: string,
  fallback: T,
  guard?: (value: unknown) => value is T,
): T {
  const raw = readSafeStorage(key);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (guard && !guard(parsed)) return fallback;
    return parsed as T;
  } catch {
    // 半写入/手改/跨版本残留的坏 JSON：静默回退，不打扰用户。
    return fallback;
  }
}

export function writeSafeJSON(key: string, value: unknown): boolean {
  try {
    return writeSafeStorage(key, JSON.stringify(value));
  } catch {
    // 循环引用 / BigInt 等不可序列化场景。
    return false;
  }
}
