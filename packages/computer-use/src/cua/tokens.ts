/**
 * cua/tokens.ts — element token ledger.
 *
 * Aligned with the ZCode/Codex registry semantics (plan 575 §2): the
 * model addresses elements by the `[n]` index of the observation it
 * saw, scoped to that window's app_ref; actions fail closed when the
 * index was never issued or was superseded. The ledger also carries
 * the observation epoch so the service can hand the probe's staleness
 * guards the title/controlType recorded at issuance time.
 *
 * Token identity = (hwnd, 1-based enumerate emission index) — the
 * probe's cache slot. The probe re-validates the cached element at
 * action time (plan 564 stale-tree guard), so the ledger only routes
 * and never trusts the slot blindly.
 */

export interface CuaTokenIdentity {
  pid: number | null;
  hwnd: number;
  /** 1-based enumerate emission order (probe cache slot). */
  probeIndex: number;
  /** Enumerate epoch that issued the token (monotonic per hwnd). */
  epoch: number;
}

const MAX_SESSIONS_WINDOWS = 64;

export class CuaTokenLedger {
  private epochByHwnd = new Map<number, number>();
  private issued = new Map<number, Map<number, CuaTokenIdentity>>();

  /** Current tree epoch for a hwnd (0 = never observed). */
  currentEpoch(hwnd: number): number {
    return this.epochByHwnd.get(hwnd) ?? 0;
  }

  /**
   * Register a fresh observation: bumps the hwnd epoch and registers
   * indices 1..count. Returns the epoch the snapshot was issued under.
   */
  issueSnapshot(hwnd: number, count: number, pid: number | null): number {
    const epoch = (this.epochByHwnd.get(hwnd) ?? 0) + 1;
    this.epochByHwnd.set(hwnd, epoch);
    const slots = new Map<number, CuaTokenIdentity>();
    for (let index = 1; index <= count; index += 1) {
      slots.set(index, { pid, hwnd, probeIndex: index, epoch });
    }
    this.issued.set(hwnd, slots);
    if (this.issued.size > MAX_SESSIONS_WINDOWS) {
      // Wholesale eviction of the oldest window (simplest correct policy;
      // windows are re-observed on demand anyway).
      const oldest = this.issued.keys().next();
      if (!oldest.done) this.issued.delete(oldest.value);
    }
    return epoch;
  }

  /**
   * Resolve a model-facing index against a window's latest observation.
   * Null = never issued in this session, or the window was re-observed
   * and this slot is gone from the fresh tree — re-observe.
   */
  resolve(hwnd: number, probeIndex: number): CuaTokenIdentity | null {
    const slots = this.issued.get(hwnd);
    if (!slots) return null;
    return slots.get(probeIndex) ?? null;
  }

  /** Whether the hwnd has any live observation (window-scoped gating). */
  isObserved(hwnd: number): boolean {
    return this.issued.has(hwnd);
  }

  /** Retire a slot (action failed stale-tree; re-observe required). */
  retire(hwnd: number, probeIndex: number): void {
    this.issued.get(hwnd)?.delete(probeIndex);
  }

  /** stop_computer_control: forget every identity. */
  clear(): void {
    this.issued.clear();
    this.epochByHwnd.clear();
  }
}
