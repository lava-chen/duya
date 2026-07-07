import React from "react";
import { useConductorStore } from "..//stores/conductor-store";

interface CanvasErrorBoundaryProps {
  children: React.ReactNode;
}

interface CanvasErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

export class CanvasErrorBoundary extends React.Component<
  CanvasErrorBoundaryProps,
  CanvasErrorBoundaryState
> {
  constructor(props: CanvasErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: "" };
  }

  static getDerivedStateFromError(error: Error): CanvasErrorBoundaryState {
    return { error, componentStack: "" };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? "" });
    // eslint-disable-next-line no-console
    console.error("[CanvasErrorBoundary] Conductor render error:", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null, componentStack: "" });
    const store = useConductorStore.getState();
    store.clearSelection();
  };

  render(): React.ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--main-bg)] p-6">
        <section className="w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-5 shadow-lg">
          <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
            Conductor canvas recovered
          </div>
          <h2 className="mt-2 text-lg font-semibold">Canvas failed to render</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
            The chat surface and other parts of the app still work. You can clear the canvas
            state and continue, or pick a different canvas from the selector above.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-canvas)] p-3 text-xs whitespace-pre-wrap">
            {error.message || String(error)}
            {componentStack ? `\n\n${componentStack}` : ""}
          </pre>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)]"
            >
              Reset canvas state
            </button>
          </div>
        </section>
      </div>
    );
  }
}