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
        // Drop patches for other canvases. The main process broadcasts
        // every canvas's patches to every subscriber; without this guard,
        // patches from canvas A get applied to the store while canvas B
        // is being displayed, producing "phantom" elements that vanish
        // after a refresh (which reloads only the bound canvas).
        const patchCanvasId = (data as { canvasId?: unknown }).canvasId;
        if (patchCanvasId && this.canvasId && patchCanvasId !== this.canvasId) {
          return;
        }
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
