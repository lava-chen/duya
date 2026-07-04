import React from 'react';

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: '' };
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, componentStack: '' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' });
    console.error('[AppErrorBoundary] Unhandled render error:', error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  private reset = (): void => {
    this.setState({ error: null, componentStack: '' });
  };

  render(): React.ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen bg-[var(--bg-canvas,#181818)] text-[var(--text,#f4f4f5)] flex items-center justify-center p-6">
        <section className="w-full max-w-2xl rounded-lg border border-[var(--border,#3a3a3a)] bg-[var(--bg-surface,#202020)] p-6 shadow-2xl">
          <div className="text-xs uppercase tracking-wide text-[var(--text-secondary,#a1a1aa)]">
            Duya renderer recovered
          </div>
          <h1 className="mt-2 text-xl font-semibold">Something went wrong in the interface</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary,#a1a1aa)]">
            The agent process may still be running. Reloading only refreshes the interface and reloads the session from local state.
          </p>
          <pre className="mt-4 max-h-48 overflow-auto rounded-md border border-[var(--border,#3a3a3a)] bg-[var(--bg-canvas,#181818)] p-3 text-xs whitespace-pre-wrap">
            {error.message || String(error)}
            {componentStack ? `\n\n${componentStack}` : ''}
          </pre>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="rounded-md bg-[var(--accent,#8b5cf6)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Reload interface
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md border border-[var(--border,#3a3a3a)] px-4 py-2 text-sm text-[var(--text,#f4f4f5)] hover:bg-[var(--bg-hover,#2a2a2a)]"
            >
              Try again
            </button>
          </div>
        </section>
      </div>
    );
  }
}
