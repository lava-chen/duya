import { getSnapshot } from './conductor-ipc';
import type { ConductorSnapshot } from '../types/conductor';

type StatePatchHandler = (patch: Record<string, unknown>) => void;
type SnapshotHandler = (snapshot: ConductorSnapshot) => void;

class ConductorBridgeClass {
  private handlers = new Set<StatePatchHandler>();
  private snapshotHandlers = new Set<SnapshotHandler>();
  private portUnsubscribe: (() => void) | null = null;
  private canvasId: string | null = null;

  connect(canvasId: string): () => void {
    this.canvasId = canvasId;

    const port = window.electronAPI?.getConductorPort?.();
    if (port) {
      this.portUnsubscribe = port.onStatePatch((data) => {
        for (const handler of this.handlers) {
          try {
            handler(data);
          } catch {}
        }
      });
    }

    return () => {
      this.disconnect();
    };
  }

  disconnect(): void {
    this.portUnsubscribe?.();
    this.portUnsubscribe = null;
    this.canvasId = null;
  }

  onStatePatch(handler: StatePatchHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async refreshSnapshot(): Promise<ConductorSnapshot | null> {
    if (!this.canvasId) return null;
    const snapshot = await getSnapshot(this.canvasId);
    if (snapshot) {
      for (const handler of this.snapshotHandlers) {
        try {
          handler(snapshot);
        } catch {}
      }
    }
    return snapshot;
  }

  onSnapshot(handler: SnapshotHandler): () => void {
    this.snapshotHandlers.add(handler);
    return () => {
      this.snapshotHandlers.delete(handler);
    };
  }

  destroy(): void {
    this.disconnect();
    this.handlers.clear();
    this.snapshotHandlers.clear();
  }
}

export const ConductorBridge = new ConductorBridgeClass();
