import React from 'react';
import { Button } from '@/components/ui/Button';
import { logger, serializeErrorForLog } from '@/lib/logger';
import { cn } from '@/lib/utils';

/**
 * ErrorBoundary — 分级的 React 崩溃隔离。
 *
 * duya 此前只有 `WidgetErrorBoundary`（保护单个聊天挂件），主界面缺少任何
 * 顶层边界：任一子树抛错都会让整棵 React 树卸载，用户看到的是一片空白窗口
 * （boot splash 已被隐藏），既不知道发生了什么也无法恢复。
 *
 * 这里提供两级：
 *   - `AppErrorBoundary`：根级兜底，展示可复制的诊断信息与"重新加载"。
 *   - `ScopedErrorBoundary`：按面板隔离（侧边栏/终端/设置/画布…），
 *     单个面板崩溃时其余界面照常可用，只有那块区域降级。
 *
 * 关键约束：崩溃态下**不能**依赖 i18n Provider、ThemeProvider 或 store。
 * 崩溃的根因可能就在这些 Provider 里，再去读它们会二次抛错，把"降级 UI"
 * 也一起拖垮。所以文案用内联常量，不读任何Provider。
 */

export type ErrorBoundaryVariant = 'panel' | 'inline' | 'compact' | 'silent';

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 隔离区域名，写进日志与降级文案，便于定位。 */
  scope?: string;
  /** 'silent' 直接渲染 null（用于"没有它也能用"的装饰性区块）。 */
  variant?: ErrorBoundaryVariant;
  /** 这些值变化时自动复位，无需用户手动重试（例如切换会话/项目）。 */
  resetKeys?: unknown[];
  /** 自定义降级 UI，接收错误与 reset。 */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  onError?: (error: Error, componentStack: string | null) => void;
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function sameKeys(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export class ScopedErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
    this.prevResetKeys = props.resetKeys ?? [];
  }

  /** 不在 state 里存快照：避免"更新 resetKeys 触发 setState"的二次渲染。 */
  private prevResetKeys: unknown[];

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const scope = this.props.scope ?? 'unknown';
    logger.error(
      `[ErrorBoundary:${scope}] subtree crashed`,
      serializeErrorForLog(error),
      errorInfo.componentStack ?? null,
    );
    this.props.onError?.(error, errorInfo.componentStack ?? null);
  }

  componentDidUpdate(): void {
    const { resetKeys } = this.props;
    if (!resetKeys) return;
    // 只在"真的变了"时复位，否则父级每次重渲染都会清掉刚恢复的内容。
    if (this.state.error && !sameKeys(this.prevResetKeys, resetKeys)) {
      this.prevResetKeys = resetKeys;
      this.reset();
      return;
    }
    this.prevResetKeys = resetKeys;
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    const { children, variant = 'panel', scope, fallback, className } = this.props;

    if (!error) return children;
    if (variant === 'silent') return null;
    if (fallback) return fallback(error, this.reset);

    const label = scope ? `“${scope}”` : '此区域';

    if (variant === 'inline') {
      return (
        <span className={cn('inline-flex items-center gap-1 text-error', className)} role="status">
          <span>{label}加载失败</span>
          <button
            type="button"
            onClick={this.reset}
            className="underline underline-offset-2 hover:opacity-80"
          >
            重试
          </button>
        </span>
      );
    }

    if (variant === 'compact') {
      return (
        <div
          className={cn(
            'flex items-center justify-between gap-2 rounded-lg border border-error-soft bg-error-soft px-2.5 py-1.5 text-error',
            className,
          )}
          role="alert"
        >
          <span className="min-w-0 truncate">
            {label}加载失败：{error.message}
          </span>
          <Button size="sm" variant="secondary" onClick={this.reset}>
            重试
          </Button>
        </div>
      );
    }

    return (
      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-foreground',
          className,
        )}
        role="alert"
      >
        <div className="font-medium">{label}加载失败</div>
        <div className="text-muted-foreground break-words">
          {error.message || '发生未知错误'}
        </div>
        <div>
          <Button size="sm" variant="secondary" onClick={this.reset}>
            重试
          </Button>
        </div>
      </div>
    );
  }
}

/**
 * 根级边界。崩溃时给出完整诊断（错误名/消息/堆栈前若干行）与两个出口：
 * 重试（重建子树）与重新加载（彻底重开窗口）。
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode; onError?: ErrorBoundaryProps['onError'] },
  { error: Error | null }
> {
  constructor(props: {
    children: React.ReactNode;
    onError?: ErrorBoundaryProps['onError'];
  }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.error(
      '[AppErrorBoundary] application crashed',
      serializeErrorForLog(error),
      errorInfo.componentStack ?? null,
    );
    this.props.onError?.(error, errorInfo.componentStack ?? null);
  }

  private reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stack = (error.stack ?? '').split('\n').slice(0, 12).join('\n');

    return (
      <div
        role="alert"
        className="flex h-screen flex-col gap-4 overflow-auto bg-background p-8 text-foreground"
      >
        <h1 className="m-0 text-lg font-semibold">界面遇到错误</h1>
        <p className="m-0 text-muted-foreground">
          应用的某个部分崩溃了。可以先重试；如果反复出现，请重新加载窗口。
        </p>
        <pre className="m-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-mono text-xs leading-relaxed">
{error.name}: {error.message}
{stack ? `\n${stack}` : ''}
        </pre>
        <div className="flex gap-2">
          <Button variant="primary" onClick={this.reset}>
            重试
          </Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }
}
