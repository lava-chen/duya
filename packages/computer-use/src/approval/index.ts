/**
 * approval/index.ts — approval callback abstraction (plan 454 §5 Task D).
 *
 * Destructive actions (click / window_switch / drag / set_value)
 * require explicit user confirmation before they fire. This module
 * owns the contract between the desktop backend and the renderer UI:
 *
 *   1. Backend dispatches an approval request through an ApprovalBridge.
 *   2. The bridge pushes the request to the renderer over IPC.
 *   3. The renderer shows a 3-second countdown confirmation popover.
 *   4. The user clicks "Allow" / "Deny" (or the timeout expires).
 *   5. The bridge resolves the promise with the user's decision.
 *
 * The bridge is a thin interface so:
 *   - Tests can supply an in-memory bridge that resolves immediately.
 *   - The Electron main process supplies an IPC bridge that talks to
 *     the renderer over `automation:computer-use:approval-request`.
 *
 * All public APIs are async. No throwing — failures return `denied`.
 */

import type { ComputerUseAction } from '../types.js';
export type { ComputerUseAction };

/**
 * The shape of a single approval request. The renderer renders this
 * directly (with light formatting) so the labels must be human-readable.
 */
export interface ApprovalRequest {
  /** Stable id for the request (used for cancellation correlation). */
  requestId: string;
  /** Action that's about to fire (e.g. 'click'). */
  action: ComputerUseAction;
  /** Compact arguments preview (no PII, no full PII dumps). */
  argsPreview: Record<string, unknown>;
  /** Free-form rationale the model can attach (optional). */
  rationale?: string;
  /** When the request was issued (ISO). */
  issuedAt: string;
  /** Auto-cancel deadline (ms after issuedAt). */
  timeoutMs: number;
}

export interface ApprovalResult {
  requestId: string;
  /** True when the user explicitly allowed the action. */
  approved: boolean;
  /** 'user' for explicit allow/deny, 'timeout' for auto-cancel. */
  reason: 'user-allow' | 'user-deny' | 'timeout' | 'bridge-error';
}

/**
 * The bridge contract. Phase 2 wires an ElectronIPCApprovalBridge;
 * tests supply an inline bridge.
 */
export interface ApprovalBridge {
  /**
   * Push an approval request to the user. Resolves when the user
   * responds (allow / deny) OR when the request times out.
   *
   * Implementations must enforce `timeoutMs` even when the user is
   * actively responding — a slow click must not lock up the agent.
   */
  requestApproval(req: ApprovalRequest): Promise<ApprovalResult>;
  /**
   * Optional: revoke a pending request (used by the renderer "Cancel"
   button when the user changes their mind).
   */
  cancel?(requestId: string): void;
}

/**
 * In-memory bridge for tests + headless contexts. The bridge resolves
 * immediately according to a configurable policy:
 *   - `policy: 'auto-allow'` always resolves approved (CI smoke).
 *   - `policy: 'auto-deny'` always resolves denied (CI smoke).
 *   - `policy: 'manual'` lets tests resolve individual requests via
 *     `resolve()`.
 */
export class InMemoryApprovalBridge implements ApprovalBridge {
  readonly requests: ApprovalRequest[] = [];
  readonly decisions: Map<string, ApprovalResult> = new Map();
  /** Pending resolvers keyed by requestId. */
  private readonly pending = new Map<
    string,
    (result: ApprovalResult) => void
  >();
  private readonly policy: 'auto-allow' | 'auto-deny' | 'manual';
  private readonly defaultTimeoutMs: number;

  constructor(
    opts: { policy?: 'auto-allow' | 'auto-deny' | 'manual'; defaultTimeoutMs?: number } = {},
  ) {
    this.policy = opts.policy ?? 'manual';
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 3_000;
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    this.requests.push(req);
    if (this.policy === 'auto-allow') {
      return {
        requestId: req.requestId,
        approved: true,
        reason: 'user-allow',
      };
    }
    if (this.policy === 'auto-deny') {
      return {
        requestId: req.requestId,
        approved: false,
        reason: 'user-deny',
      };
    }
    // Manual: enqueue + wait, with timeout.
    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.requestId);
        const result: ApprovalResult = {
          requestId: req.requestId,
          approved: false,
          reason: 'timeout',
        };
        this.decisions.set(req.requestId, result);
        resolve(result);
      }, Math.min(this.defaultTimeoutMs, req.timeoutMs));
      this.pending.set(req.requestId, (decision) => {
        clearTimeout(timer);
        this.decisions.set(req.requestId, decision);
        resolve(decision);
      });
    });
  }

  /** Test helper: resolve a pending request. */
  resolve(requestId: string, approved: boolean): void {
    const cb = this.pending.get(requestId);
    if (!cb) return;
    this.pending.delete(requestId);
    cb({
      requestId,
      approved,
      reason: approved ? 'user-allow' : 'user-deny',
    });
  }

  /** Test helper: number of currently-pending requests. */
  pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Module-level default bridge. Production wires this in main.ts;
 * tests can replace it. A `NoopApprovalBridge` returns approved=true
 * immediately so unit tests don't block.
 */
let _defaultBridge: ApprovalBridge = new InMemoryApprovalBridge({
  policy: 'auto-allow',
  defaultTimeoutMs: 3_000,
});

/**
 * Get the default approval bridge. The bridge is initialized to an
 * auto-allow InMemoryApprovalBridge so unit tests that forget to
 * install one still work.
 */
export function getDefaultApprovalBridge(): ApprovalBridge {
  return _defaultBridge;
}

/**
 * Replace the default bridge. Used by main.ts at boot.
 */
export function setDefaultApprovalBridge(bridge: ApprovalBridge): void {
  _defaultBridge = bridge;
}

/**
 * Test-only: reset the default to the inline auto-allow bridge.
 */
export function __resetDefaultApprovalBridge(): void {
  _defaultBridge = new InMemoryApprovalBridge({
    policy: 'auto-allow',
    defaultTimeoutMs: 3_000,
  });
}

/**
 * Build a compact args preview suitable for the approval UI. Drops
 * raw text > 80 chars (replaces with '...') and strips `delayMs` /
 * `timeoutMs` knobs the user doesn't care about.
 */
export function buildArgsPreview(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'timeoutMs' || k === 'delayMs') continue;
    if (typeof v === 'string' && v.length > 80) {
      out[k] = `${v.slice(0, 77)}...`;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === 'string' && x.length > 80 ? `${x.slice(0, 77)}...` : x));
      continue;
    }
    out[k] = v;
  }
  return out;
}