/**
 * logger — 渲染进程结构化日志。
 *
 * 为什么不用裸 `console.*`：
 *   - 生产包里 263 处 console 调用全部照常执行，字符串拼接与对象序列化都在
 *     主线程上发生，高频流事件（SSE chunk、工具更新）会直接抖动画面；
 *   - 无法按级别关闭，也无法统一打上来源前缀，排查时全是无主的输出；
 *   - 无法把渲染进程日志转发到 duya 的日志文件（`logger:export*`）。
 *
 * 设计（与 duya 主进程 logger 的语义保持一致）：
 *   debug 高频诊断（流分片、逐条工具更新）——生产环境默认完全 no-op
 *   info  生命周期、一次性初始化
 *   warn  可恢复异常
 *   error 崩溃、握手失败、鉴权丢失
 *
 * 生产环境默认只放行 warn/error；debug/info 需要显式打开
 * `window.__DUYA_RENDERER_DEBUG_LOG__ = true`（或调用 `setLogLevel`）。
 *
 * 落盘桥接：调用 `setLogSink()` 注入转发函数（Electron 侧接 ipc 即可），
 * 未注入时日志只走 console。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 生产构建判定：Vite 与 esbuild 都注入 import.meta.env.PROD。 */
function isProductionBuild(): boolean {
  try {
    return (
      import.meta.env?.PROD === true ||
      (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production')
    );
  } catch {
    return false;
  }
}

function isDebugOptIn(): boolean {
  try {
    return (window as unknown as Record<string, unknown>)
      .__DUYA_RENDERER_DEBUG_LOG__ === true;
  } catch {
    return false;
  }
}

let minLevel: LogLevel | null = null;

function effectiveMinLevel(): LogLevel {
  if (minLevel) return minLevel;
  if (isDebugOptIn()) return 'debug';
  return isProductionBuild() ? 'warn' : 'debug';
}

/** 手动覆盖最低级别（排查时 `logger.setLogLevel('debug')`）。传 null 恢复自动。 */
export function setLogLevel(level: LogLevel | null): void {
  minLevel = level;
}

export type LogSink = (level: LogLevel, scope: string, args: unknown[]) => void;
let sink: LogSink | null = null;

/** 注入落盘桥（Electron 主进程转发）。传 null 解除。 */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[effectiveMinLevel()]) return;
  const prefix = scope ? `[${scope}]` : '[duya]';
  const consoleFn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'info'
          ? console.info
          : console.debug;
  consoleFn(prefix, ...args);
  try {
    sink?.(level, scope, args);
  } catch {
    // 落盘桥自身的失败绝不能反过来打断业务。
  }
}

/** 把 Error/unknown 压成可结构化上报的普通对象，避免循环引用与不可枚举字段。 */
export function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(Object.keys(error).length > 0 ? { cause: (error as Error & { cause?: unknown }).cause } : {}),
    };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { value: JSON.parse(JSON.stringify(error)) };
  } catch {
    return { value: String(error) };
  }
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** 派生带固定作用域的子 logger，便于按模块过滤。 */
  child: (childScope: string) => Logger;
}

function createLogger(scope: string): Logger {
  const at = (level: LogLevel) => (...args: unknown[]) => emit(level, scope, args);
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (childScope: string) =>
      createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const logger: Logger = createLogger('');

/** 按模块取一个带作用域的 logger：`const log = scopedLogger('chat')`。 */
export function scopedLogger(scope: string): Logger {
  return createLogger(scope);
}
