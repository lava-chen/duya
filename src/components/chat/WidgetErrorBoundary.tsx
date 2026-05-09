'use client';

import React from 'react';

interface WidgetErrorBoundaryProps {
  children: React.ReactNode;
  widgetCode?: string;
}

interface WidgetErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  showSource: boolean;
}

export class WidgetErrorBoundary extends React.Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  constructor(props: WidgetErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '', showSource: false };
  }

  static getDerivedStateFromError(error: Error): Partial<WidgetErrorBoundaryState> {
    return { hasError: true, errorMessage: error.message || 'Unknown widget error' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[WidgetErrorBoundary] Widget render error:', error, info.componentStack);
  }

  toggleSource = (): void => {
    this.setState(prev => ({ showSource: !prev.showSource }));
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="my-3 p-3 rounded-lg border border-red-500/30 bg-red-500/5 text-sm">
          <div className="flex items-center gap-2 text-red-500 font-medium">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 5v3M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Widget Render Error
          </div>
          <p className="mt-1 text-[var(--text-secondary)]">
            {this.state.errorMessage}
          </p>
          {this.props.widgetCode && (
            <div className="mt-2">
              <button
                type="button"
                onClick={this.toggleSource}
                className="text-[11px] text-[var(--accent)] hover:underline cursor-pointer"
              >
                {this.state.showSource ? 'Hide source' : 'View source'}
              </button>
              {this.state.showSource && (
                <pre className="mt-2 p-2 rounded bg-[var(--bg-canvas)] border border-[var(--border)] text-[11px] font-mono overflow-auto max-h-48 whitespace-pre-wrap">
                  {this.props.widgetCode}
                </pre>
              )}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
