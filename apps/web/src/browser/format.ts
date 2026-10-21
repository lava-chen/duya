/**
 * Tiny formatters used by the React surface.
 *
 * Kept in one place so the rest of the UI does not reinvent `Intl` calls, and
 * so swapping the locale later is a one-line change.
 */

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const day = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });

/** A clock time for a turn timestamp, or an empty string for live rows. */
export function formatClock(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return clock.format(new Date(at));
}

/** A longer date stamp for the conversation header. */
export function formatDay(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return day.format(new Date(at));
}

/** A relative phrase. `null` means "not long enough ago to matter". */
export function formatRecency(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const diff = Math.max(0, now - at);
  if (diff < 30_000) return '刚刚';
  if (diff < 60_000) return `${Math.round(diff / 1_000)} 秒前`;
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))} 小时前`;
  return `${Math.round(diff / (24 * 60 * 60_000))} 天前`;
}

/** A short duration in milliseconds. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1_000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** A token count, with thousands separators and a short tail. */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** A friendly label for one tool-call phase. */
export function formatToolPhase(phase: string): string {
  switch (phase) {
    case 'preview':
      return '准备中';
    case 'streaming_arguments':
      return '参数生成中';
    case 'started':
      return '执行中';
    case 'progress':
      return '进行中';
    case 'completed':
      return '已完成';
    case 'timed_out':
      return '超时';
    default:
      return phase;
  }
}

/** A friendly label for a durable run status. */
export function formatRunStatus(status: string, cancelRequested: boolean): string {
  if (cancelRequested && status === 'running') return '已请求取消';
  switch (status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'failed':
      return '已失败';
    case 'budget_exhausted':
      return '已用尽预算';
    default:
      return status;
  }
}
