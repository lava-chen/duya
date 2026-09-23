/**
 * gui-backend.ts — worker-side production GuiBackendPort (plan 556 Phase 4).
 *
 * Maps the gui-runner step contract onto the main-process computer-use
 * dispatcher (`computer-use:execute`), which owns the DesktopBackend
 * singleton. The worker never touches nut.js / desktopCapturer directly —
 * every step is one flattened { action, payload, sessionId } envelope
 * over the worker→main RPC bridge, and the response envelope's
 * `verdict.effect` (plan 519 §3.5 read-back) feeds the gui-runner's
 * verify ladder.
 *
 * SOM contract: `som:<n>` refs arriving here are ALREADY resolved against
 * the freshest capture's index space (element-matcher.ts ran upstream).
 * The dispatcher's backend resolves `element: <n>` against its own last
 * capture — which is the same capture this port published — so indices
 * align without extra state.
 */

import { SOM_ELEMENT_RE, type GuiStep } from '../modes/workflow/schema.js';
import type {
  GuiBackendPort,
  GuiCaptureResult,
  GuiStepResult,
} from '../modes/workflow/gui-runner.js';
import type { HostCallContext } from '../modes/workflow/host.js';

/** One worker→main computer-use RPC. */
export type ComputerUseRequest = (
  action: string,
  payload: Record<string, unknown>,
  options?: { timeout?: number },
) => Promise<{
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}>;

/** The capture slice of the dispatcher's CaptureResult envelope. */
interface DispatcherCapture {
  base64?: string | null;
  width?: number;
  height?: number;
  elements?: unknown;
}

/** ActionResult slice carrying the plan 519 read-back verdict. */
interface DispatcherActionResult {
  ok?: boolean;
  reason?: string;
  verdict?: { effect?: string };
}

const VERIFY_EFFECTS = new Set(['confirmed', 'unverifiable', 'suspected_noop']);

/** Extract the verify-ladder effect from a dispatcher payload. */
function extractEffect(data: unknown): GuiStepResult['effect'] {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  // `type` nests its ActionResult under `typeResult`; every other
  // state-changing action returns the ActionResult verbatim.
  const action = (record.typeResult ?? record) as DispatcherActionResult | undefined;
  const effect = action?.verdict?.effect;
  return effect !== undefined && VERIFY_EFFECTS.has(effect)
    ? (effect as GuiStepResult['effect'])
    : undefined;
}

function parseSomIndex(ref: string): number | null {
  if (!SOM_ELEMENT_RE.test(ref)) return null;
  // SOM_ELEMENT_RE has no capture group — the index is the text after "som:".
  const index = Number.parseInt(ref.slice(4), 10);
  return Number.isFinite(index) && index > 0 ? index : null;
}

/** Capture → the port shape (throws on dispatcher failure). */
async function captureOnce(request: ComputerUseRequest): Promise<GuiCaptureResult> {
  const res = await request('capture', { somMode: true }, { timeout: 30_000 });
  if (!res.success) {
    throw new Error(res.error?.message ?? 'computer-use capture failed');
  }
  const data = (res.data ?? {}) as DispatcherCapture;
  return {
    base64: typeof data.base64 === 'string' ? data.base64 : null,
    ...(typeof data.width === 'number' ? { width: data.width } : {}),
    ...(typeof data.height === 'number' ? { height: data.height } : {}),
    ...(data.elements !== undefined ? { elements: data.elements } : {}),
  };
}

/** Best-effort: focus the recorded field before typing into it. */
async function clickSomElement(
  request: ComputerUseRequest,
  ref: string,
): Promise<GuiStepResult | null> {
  const index = parseSomIndex(ref);
  if (index === null) {
    return { ok: false, error: `unresolvable element ref "${ref}"` };
  }
  const res = await request('click', { element: index }, { timeout: 30_000 });
  if (!res.success) {
    return { ok: false, error: res.error?.message ?? `click on ${ref} failed` };
  }
  return null;
}

/**
 * Build the production backend port over a computer-use RPC closure.
 * The closure binds the sessionId (overlay routing + capture-size
 * bookkeeping happen main-side); the port stays stateless.
 */
export function createIpcGuiBackend(request: ComputerUseRequest): GuiBackendPort {
  return {
    async capture(_ctx: HostCallContext): Promise<GuiCaptureResult> {
      return captureOnce(request);
    },

    async step(step: GuiStep, _ctx: HostCallContext): Promise<GuiStepResult> {
      try {
        switch (step.do) {
          case 'capture': {
            const frame = await captureOnce(request);
            return { ok: true, frame };
          }

          case 'click': {
            const index = parseSomIndex(step.element);
            if (index === null) {
              return { ok: false, error: `unresolvable element ref "${step.element}"` };
            }
            const res = await request('click', { element: index }, { timeout: 30_000 });
            if (!res.success) {
              return { ok: false, error: res.error?.message ?? `click ${step.element} failed` };
            }
            return { ok: true, effect: extractEffect(res.data) };
          }

          case 'type_text': {
            if (step.element !== undefined) {
              const focusFailure = await clickSomElement(request, step.element);
              if (focusFailure) return focusFailure;
            }
            const res = await request('type', { text: step.text }, { timeout: 60_000 });
            if (!res.success) {
              return { ok: false, error: res.error?.message ?? 'type failed' };
            }
            return { ok: true, effect: extractEffect(res.data) };
          }

          case 'set_value': {
            if (step.element !== undefined) {
              const focusFailure = await clickSomElement(request, step.element);
              if (focusFailure) return focusFailure;
            }
            const res = await request('set_value', { value: step.text }, { timeout: 60_000 });
            if (!res.success) {
              return { ok: false, error: res.error?.message ?? 'set_value failed' };
            }
            return { ok: true, effect: extractEffect(res.data) };
          }

          case 'key': {
            const res = await request('key', { key: step.key }, { timeout: 30_000 });
            if (!res.success) {
              return { ok: false, error: res.error?.message ?? `key ${step.key} failed` };
            }
            return { ok: true, effect: extractEffect(res.data) };
          }

          case 'scroll': {
            const res = await request(
              'scroll',
              {
                ...(step.direction !== undefined ? { direction: step.direction } : {}),
                ...(step.amount !== undefined ? { amount: step.amount } : {}),
              },
              { timeout: 30_000 },
            );
            if (!res.success) {
              return { ok: false, error: res.error?.message ?? 'scroll failed' };
            }
            return { ok: true, effect: extractEffect(res.data) };
          }

          default: {
            // Exhaustiveness guard — a new GuiStep variant must be mapped
            // here or it fails loudly instead of silently doing nothing.
            return { ok: false, error: `unsupported gui step "${(step as { do: string }).do}"` };
          }
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
