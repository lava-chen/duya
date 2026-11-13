import type { InputMouseEvent } from '../terminal/input-driver.js';

export interface HitRegion {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly height: number;
  readonly revision?: string | number;
  readonly drag?: (phase: 'start' | 'move' | 'end' | 'cancel', point: { readonly x: number; readonly y: number }) => void;
  readonly activate: (point: { readonly x: number; readonly y: number }) => void;
}

const MULTI_CLICK_MS = 280;

/** Regions come from the committed frame, never from a second layout pass. */
export class PointerDispatcher {
  private regions: readonly HitRegion[] = [];
  private press: { region: HitRegion; x: number; y: number; moved: boolean } | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private lastClick: { id: string; at: number } | undefined;

  commit(regions: readonly HitRegion[]): void {
    this.regions = regions;
    const press = this.press;
    if (press && !regions.some((region) => region.id === press.region.id
      && region.revision === press.region.revision)) this.cancel();
  }

  cancel(): void {
    const press = this.press;
    this.press = undefined;
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    this.lastClick = undefined;
    press?.region.drag?.('cancel', { x: press.x, y: press.y });
  }

  clear(): void {
    this.cancel();
    this.regions = [];
  }

  private hit(x: number, y: number): HitRegion | undefined {
    for (let index = this.regions.length - 1; index >= 0; index--) {
      const region = this.regions[index]!;
      if (x >= region.column && y >= region.row
        && x < region.column + region.width && y < region.row + region.height) return region;
    }
    return undefined;
  }

  hasHit(x: number, y: number): boolean {
    return this.hit(x, y) !== undefined;
  }

  handle(event: InputMouseEvent): void {
    if (event.shift || event.ctrl || event.meta
      || event.action === 'wheelup' || event.action === 'wheeldown') {
      this.cancel();
      return;
    }
    if (event.action === 'mousemove') {
      if (this.press) {
        if (event.x !== this.press.x || event.y !== this.press.y) this.press.moved = true;
        this.press.region.drag?.('move', { x: event.x, y: event.y });
      }
      return;
    }
    if (event.button !== 0) {
      this.cancel();
      return;
    }
    const hit = this.hit(event.x, event.y);
    if (event.action === 'mousedown') {
      if (this.press) this.cancel();
      if (this.pending !== undefined) clearTimeout(this.pending);
      this.pending = undefined;
      this.press = hit ? { region: hit, x: event.x, y: event.y, moved: false } : undefined;
      hit?.drag?.('start', { x: event.x, y: event.y });
      return;
    }
    const press = this.press;
    this.press = undefined;
    if (press?.region.drag) {
      press.region.drag(press.moved ? 'end' : 'cancel', { x: event.x, y: event.y });
      this.lastClick = undefined;
      return;
    }
    if (!press || press.moved || press.x !== event.x || press.y !== event.y || !hit
      || hit.id !== press.region.id || hit.revision !== press.region.revision) return;

    // Delay a single click so double/triple clicks cannot also activate a row.
    const at = Date.now();
    if (this.lastClick?.id === hit.id && at - this.lastClick.at < MULTI_CLICK_MS) {
      this.lastClick = { id: hit.id, at };
      return;
    }
    this.lastClick = { id: hit.id, at };
    this.pending = setTimeout(() => {
      this.pending = undefined;
      const current = this.hit(event.x, event.y);
      if (current?.id === hit.id && current.revision === hit.revision) {
        current.activate({ x: event.x, y: event.y });
      }
    }, MULTI_CLICK_MS);
    this.pending.unref?.();
  }
}
