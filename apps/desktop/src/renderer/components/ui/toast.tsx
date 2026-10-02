import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/ui/IconButton';
import { XIcon } from '@/components/icons';

/**
 * toast — 轻量通知队列。
 *
 * duya 此前没有统一的通知出口：成功/失败要么静默，要么散落在各处用
 * 临时 DOM 或 alert 替代，导致"操作到底成没成功"全靠猜。
 *
 * 三个容易被忽略、但决定了通知是否可信的细节：
 *
 *  1. `dedupeKey` —— 同一个业务目标连续产生结果时（例如重复点击"安装"、
 *     或轮询不断重试），新结果**替换**旧结果而不是再叠一条。否则一次
 *     轮询失败就能堆出十几条一模一样的错误。
 *
 *  2. 挂载前调用 —— 模块级队列独立于 React 生命周期。`toast()` 在
 *     `<ToastProvider>` 挂载之前调用也安全：provider 挂载时同步一次快照，
 *     期间被 dismiss 的条目已经从队列里移除，不会出现"幽灵通知"。
 *
 *  3. hover 暂停 —— 鼠标移入时清掉关闭定时器，移出后重新计时。用户正在读
 *     的通知不能自己消失。
 */

export type ToastVariant = 'default' | 'success' | 'warning' | 'error';
export type ToastPosition =
  | 'top-right'
  | 'top-center'
  | 'bottom-right'
  | 'bottom-center';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** 毫秒；0 表示不自动关闭。默认：error 6000，其它 4000。 */
  duration?: number;
  /**
   * 去重键。相同 key 的新通知会替换旧通知的内容与计时，而不是新增一条。
   * 建议用"业务目标"而非"事件"做 key，例如 `install:${pluginId}`。
   */
  dedupeKey?: string;
  position?: ToastPosition;
  action?: ToastAction;
}

export interface ToastRecord extends ToastOptions {
  id: string;
  createdAt: number;
}

const MAX_VISIBLE = 4;

/* ------------------------------------------------------------------ *
 * 模块级队列：与 React 生命周期解耦，保证挂载前后调用都安全。
 * ------------------------------------------------------------------ */

interface TimerEntry {
  handle: ReturnType<typeof setTimeout>;
  duration: number;
  startedAt: number;
}

let records: ToastRecord[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, TimerEntry>();
/** 鼠标悬停暂停时保存的剩余时间。 */
const remainingOnPause = new Map<string, number>();

let seq = 0;
function nextId(): string {
  seq += 1;
  return `toast-${seq}-${Date.now().toString(36)}`;
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function defaultDuration(variant: ToastVariant): number {
  return variant === 'error' ? 6000 : 4000;
}

function clearTimer(id: string): void {
  const entry = timers.get(id);
  if (entry) {
    clearTimeout(entry.handle);
    timers.delete(id);
  }
}

function scheduleDismiss(id: string, duration: number): void {
  clearTimer(id);
  remainingOnPause.delete(id);
  if (duration <= 0) return;
  const entry: TimerEntry = { handle: setTimeout(() => {
    timers.delete(id);
    dismissToast(id);
  }, duration), duration, startedAt: Date.now() };
  timers.set(id, entry);
}

/**
 * 只读内省：当前队列快照。用于单测断言与调试面板，**不要**用它驱动渲染
 * （渲染请走 `useToasts()`，否则会错过更新通知）。
 */
export function getToasts(): readonly ToastRecord[] {
  return records;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  const next = records.filter((record) => record.id !== id);
  if (next.length === records.length) return;
  records = next;
  emit();
}

export function clearToasts(): void {
  timers.forEach((entry) => clearTimeout(entry.handle));
  timers.clear();
  remainingOnPause.clear();
  if (records.length === 0) return;
  records = [];
  emit();
}

/** 命令式弹出通知，返回 id（可用于提前 dismiss）。 */
export function toast(options: ToastOptions): string {
  const variant = options.variant ?? 'default';
  const duration = options.duration ?? defaultDuration(variant);

  if (options.dedupeKey) {
    const existing = records.find((r) => r.dedupeKey === options.dedupeKey);
    if (existing) {
      // 复用同一条：内容替换 + 计时重置。位置保持不变，避免通知"跳动"。
      const index = records.indexOf(existing);
      records[index] = {
        ...existing,
        ...options,
        id: existing.id,
        variant,
        createdAt: Date.now(),
      };
      scheduleDismiss(existing.id, duration);
      emit();
      return existing.id;
    }
  }

  const record: ToastRecord = {
    ...options,
    variant,
    id: nextId(),
    createdAt: Date.now(),
  };
  records = [...records, record];
  // 超出上限时从最旧的开始回收，避免通知糊满屏幕。
  if (records.length > MAX_VISIBLE) {
    const evicted = records.slice(0, records.length - MAX_VISIBLE);
    evicted.forEach((r) => clearTimer(r.id));
    records = records.slice(records.length - MAX_VISIBLE);
  }
  scheduleDismiss(record.id, duration);
  emit();
  return record.id;
}

/** 便捷方法，语义比 `variant` 更明确。 */
toast.success = (title: string, options?: Omit<ToastOptions, 'title' | 'variant'>) =>
  toast({ ...options, title, variant: 'success' });
toast.error = (title: string, options?: Omit<ToastOptions, 'title' | 'variant'>) =>
  toast({ ...options, title, variant: 'error' });
toast.warning = (title: string, options?: Omit<ToastOptions, 'title' | 'variant'>) =>
  toast({ ...options, title, variant: 'warning' });

/* ------------------------------------------------------------------ *
 * React 层
 * ------------------------------------------------------------------ */

const POSITION_CLASSES: Record<ToastPosition, string> = {
  'top-right': 'top-4 right-4 items-end',
  'top-center': 'top-4 left-1/2 -translate-x-1/2 items-center',
  'bottom-right': 'bottom-4 right-4 items-end',
  'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 items-center',
};

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  default: 'border-border bg-popover text-foreground',
  success: 'border-success-soft bg-success-soft text-foreground',
  warning: 'border-warning-soft bg-warning-soft text-foreground',
  error: 'border-error-soft bg-error-soft text-foreground',
};

const VARIANT_ACCENT: Record<ToastVariant, string> = {
  default: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
};

export function useToasts(): ToastRecord[] {
  const [snapshot, setSnapshot] = useState(records);
  useEffect(() => {
    const listener = () => setSnapshot([...records]);
    listeners.add(listener);
    // 挂载时同步一次，拿到挂载前入队的通知。
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return snapshot;
}

export interface ToastApi {
  toast: typeof toast;
  dismiss: typeof dismissToast;
  clear: typeof clearToasts;
}

const api: ToastApi = { toast, dismiss: dismissToast, clear: clearToasts };

const ToastApiContext = React.createContext<ToastApi>(api);

/** 取命令式 API（在 provider 内外都可用，因为队列是模块级的）。 */
export function useToast(): ToastApi {
  return React.useContext(ToastApiContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const items = useToasts();

  const grouped = useMemo(() => {
    const map = new Map<ToastPosition, ToastRecord[]>();
    for (const record of items) {
      const position = record.position ?? 'bottom-right';
      const bucket = map.get(position);
      if (bucket) bucket.push(record);
      else map.set(position, [record]);
    }
    return [...map.entries()];
  }, [items]);

  /** 悬停暂停：按"已过时间"算出剩余时间并清掉定时器。 */
  const pause = useCallback((id: string) => {
    const entry = timers.get(id);
    if (!entry) return;
    clearTimeout(entry.handle);
    timers.delete(id);
    const remaining = Math.max(0, entry.duration - (Date.now() - entry.startedAt));
    remainingOnPause.set(id, remaining);
  }, []);

  /** 移出恢复：按剩余时间重新计时（此前已暂停过则沿用剩余值）。 */
  const resume = useCallback((id: string) => {
    const record = records.find((r) => r.id === id);
    if (!record) return;
    const duration = record.duration ?? defaultDuration(record.variant ?? 'default');
    // 保底 1.5s：剩余时间过小会让通知在鼠标刚离开时就消失。
    const remaining = Math.max(1500, remainingOnPause.get(id) ?? duration);
    scheduleDismiss(id, remaining);
  }, []);

  return (
    <ToastApiContext.Provider value={api}>
      {children}
      {grouped.map(([position, bucket]) => (
        <div
          key={position}
          className={cn(
            'pointer-events-none fixed z-[9999] flex flex-col gap-2',
            POSITION_CLASSES[position],
          )}
          role="region"
          aria-label="通知"
        >
          {bucket.map((record) => (
            <div
              key={record.id}
              role="status"
              aria-live="polite"
              className={cn(
                'duya-toast-enter pointer-events-auto flex w-[min(360px,calc(100vw-2rem))] items-start gap-2.5 rounded-xl border px-3 py-2.5 shadow-lg',
                VARIANT_CLASSES[record.variant ?? 'default'],
              )}
              onMouseEnter={() => pause(record.id)}
              onMouseLeave={() => resume(record.id)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                  VARIANT_ACCENT[record.variant ?? 'default'],
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium break-words">{record.title}</div>
                {record.description && (
                  <div className="mt-0.5 text-xs text-muted-foreground break-words">
                    {record.description}
                  </div>
                )}
                {record.action && (
                  <button
                    type="button"
                    onClick={() => {
                      record.action?.onClick();
                      dismissToast(record.id);
                    }}
                    className="mt-1.5 text-xs font-medium text-accent hover:underline"
                  >
                    {record.action.label}
                  </button>
                )}
              </div>
              <IconButton
                aria-label="关闭通知"
                variant="ghost"
                size="sm"
                className="-mr-1 -mt-0.5 shrink-0"
                onClick={() => dismissToast(record.id)}
              >
                <XIcon size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      ))}
    </ToastApiContext.Provider>
  );
}
