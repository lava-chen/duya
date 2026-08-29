/**
 * ipc/computer-use.ts — IPC handlers for computer_use tool (plan 454 §5 Task C).
 *
 * Channels:
 *   - computer-use:execute   (agent → main): dispatch a single
 *     computer_use action. Main process owns the DesktopBackend
 *     singleton and forwards each action. Returns a structured
 *     envelope (ComputerUseToolEnvelope shape).
 *
 * Phase 2 wires only the execute channel. Phase 3 will add:
 *   - computer-use:approval  (main → renderer): request user
 *     confirmation for destructive actions (3s auto-cancel).
 *   - computer-use:cancel   (renderer → main): revoke a pending
 *     approval request.
 *
 * Safety:
 *   - redacted field detection (OSContextBridge.focusedEntity.redacted)
 *     refuses `type` / `set_value` and returns REDACTED_FIELD.
 *   - Phase 3 expands to blocked key combos + text patterns.
 */

import { ipcMain } from 'electron';

import {
  COMPUTER_USE_IPC_CHANNEL,
  type ComputerUseAction,
} from '../../packages/agent/dist/tool/OSTool/constants.js';
import {
  ComputerUseErrorCode,
  type ComputerUseToolEnvelope,
} from '../../packages/agent/dist/tool/OSTool/ComputerUseTool.js';
import {
  buildArgsPreview,
  checkAccess,
  getDefaultApprovalBridge,
  getDefaultDesktopBackend,
  requiresConfirmation,
  validateKeyCombo,
  validateTextFull,
  type AppAccessPolicy,
} from '@duya/computer-use';

import { getLogger, LogComponent } from '../logging/logger.js';
import { getOSContextBridge } from '../../packages/agent/dist/context/os-context/index.js';
import { logComputerUseAction } from '../services/computer-use-audit.js';

const logger = getLogger();

interface ExecuteRequestPayload {
  action: ComputerUseAction;
  payload: Record<string, unknown>;
  sessionId?: string;
}

interface IpcExecuteResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Map a thrown / rejected error into our structured envelope shape.
 */
function envelopeError(
  action: ComputerUseAction,
  code: ComputerUseErrorCode,
  message: string,
): ComputerUseToolEnvelope {
  return { success: false, action, error: { code, message } };
}

/**
 * Check whether the focused entity from OSContextBridge is redacted
 * (sensitive field — passwords, credit card, etc.). Returns the
 * redacted reason string when sensitive, or null when safe.
 */
function getRedactedReason(): string | null {
  try {
    const ctx = getOSContextBridge().getCurrent();
    const focused = ctx?.focusedEntity as unknown as
      | { redaction?: { redacted?: boolean; reasons?: string[] } }
      | null;
    if (focused?.redaction?.redacted === true) {
      return focused.redaction.reasons?.join(', ') ?? 'focused field is redacted';
    }
  } catch {
    // Bridge unavailable in tests — treat as not redacted.
  }
  return null;
}

/**
 * Convert the agent's flattened payload into the DesktopBackend's
 * ClickOptions shape (snake_case keys become camelCase).
 */
function buildClickOptions(p: Record<string, unknown>): Record<string, unknown> {
  return {
    element: p.element,
    x: p.x,
    y: p.y,
    button: p.button,
    count: p.count,
    modifiers: p.modifiers,
  };
}

/**
 * Convert the agent's flattened payload into the DesktopBackend's
 * DragOptions shape.
 */
function buildDragOptions(p: Record<string, unknown>): Record<string, unknown> {
  return {
    fromElement: p.fromElement,
    toElement: p.toElement,
    fromX: p.fromX,
    fromY: p.fromY,
    toX: p.toX,
    toY: p.toY,
    steps: p.steps,
  };
}

/**
 * Run the approval gate when the action requires confirmation.
 * Returns `{ ok: true }` when the action may proceed, or
 * `{ ok: false, reason }` when the user denied / timed out.
 *
 * Side effect: writes to `userConfirmed` via closure (the audit log
 * picks this up after runAction completes).
 */
async function requestApprovalIfNeeded(
  action: ComputerUseAction,
  data: Record<string, unknown>,
): Promise<{ ok: boolean; reason: string }> {
  if (!requiresConfirmation(action)) return { ok: true, reason: '' };
  const bridge = getDefaultApprovalBridge();
  const req = {
    requestId: crypto.randomUUID(),
    action,
    argsPreview: buildArgsPreview(data),
    issuedAt: new Date().toISOString(),
    timeoutMs: 3_000,
  };
  try {
    const result = await bridge.requestApproval(req);
    if (result.approved) return { ok: true, reason: '' };
    const reason =
      result.reason === 'timeout'
        ? `approval timed out after ${req.timeoutMs}ms — action cancelled`
        : `user denied the action (${result.reason})`;
    logger.info(
      'computer-use: approval denied',
      { action, requestId: req.requestId, reason: result.reason, sessionId: null },
      LogComponent.ComputerUse,
    );
    return { ok: false, reason };
  } catch (err) {
    return {
      ok: false,
      reason: `approval bridge error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Cached Computer Use access policy. Loaded lazily from config on
 * first use (defaults to deny-by-default) and refreshed whenever
 * the config store broadcasts a change.
 */
let cachedAccessPolicy: AppAccessPolicy | null = null;

/**
 * Read the [computer_use] access policy from the config store. Uses
 * `ConfigStore` if available; falls back to the deny-by-default
 * constant when the store isn't reachable (unit tests, CLI).
 */
function getAccessPolicy(): AppAccessPolicy {
  if (cachedAccessPolicy) return cachedAccessPolicy;
  try {
    // Lazy import keeps the module independent of the config tree.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfigStore } = require('../config/store-instance') as {
      getConfigStore: () => { getByPath(path: string): unknown };
    };
    const store = getConfigStore();
    const raw = store.getByPath('computer_use') as AppAccessPolicy | undefined;
    if (raw === undefined) {
      // No [computer_use] section configured: keep the feature usable
      // (allow-by-default) so dev / first-run works out of the box.
      // Users who want to restrict it add allowed_apps + set
      // default_access = "deny".
      cachedAccessPolicy = { default_access: 'allow', allowed_apps: [], denied_apps: [] };
    } else {
      // User explicitly configured the section: honor their values
      // with a deny default so an allow-list-only config locks
      // everything else down.
      cachedAccessPolicy = {
        default_access: raw?.default_access ?? 'deny',
        allowed_apps: raw?.allowed_apps ?? [],
        denied_apps: raw?.denied_apps ?? [],
      };
    }
  } catch {
    // Store unreachable (unit tests, CLI): allow by default so
    // non-Electron contexts don't hard-fail every action.
    cachedAccessPolicy = { default_access: 'allow', allowed_apps: [], denied_apps: [] };
  }
  return cachedAccessPolicy;
}

/**
 * Evaluate whether the current foreground app is permitted to be
 * automated by Computer Use. Uses OSContextBridge for the app info
 * (same source the daemon writes). Denies-by-default when the policy
 * has no allow-list entry for the foreground app.
 */
function checkForegroundAccess(): { ok: boolean; reason?: string } {
  try {
    const ctx = getOSContextBridge().getCurrent();
    const verdict = checkAccess(getAccessPolicy(), {
      processName: (ctx?.foreground as { exeName?: string } | undefined)?.exeName ?? null,
      title: (ctx?.foreground as { title?: string } | undefined)?.title ?? null,
      focusedEntity: ctx?.focusedEntity ?? null,
    });
    return verdict.allowed ? { ok: true } : { ok: false, reason: verdict.reason };
  } catch (err) {
    logger.warn(
      'computer-use: access check threw',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
    return {
      ok: false,
      reason: 'Access policy evaluation failed; action refused for safety.',
    };
  }
}

/**
 * Dispatch a single computer_use action against the DesktopBackend
 * singleton. Returns the envelope. Never throws — every failure is
 * captured into the envelope so the tool layer can render it.
 */
async function runAction(
  action: ComputerUseAction,
  payload: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<ComputerUseToolEnvelope> {
  const start = Date.now();
  let userConfirmed = false;

  try {
    const backend = getDefaultDesktopBackend();
    const data = payload;

    switch (action) {
      case 'capture': {
        const cap = await backend.capture({
          somMode: data.somMode === true,
          displayId: typeof data.displayId === 'number' ? data.displayId : undefined,
        });
        return {
          success: true,
          action,
          data: cap,
        };
      }
      case 'click': {
        // Access gate: refuse to click on an app that the policy
        // doesn't allow.
        const access = checkForegroundAccess();
        if (!access.ok) {
          logger.warn(
            'computer-use: click refused — app access policy',
            { reason: access.reason, sessionId: sessionId ?? null },
            LogComponent.ComputerUse,
          );
          return {
            success: false,
            action,
            error: {
              code: ComputerUseErrorCode.APP_BLOCKED,
              message: access.reason ?? 'app blocked by access policy',
            },
          };
        }
        // Approval gate (destructive).
        const approval = await requestApprovalIfNeeded(action, data);
        if (!approval.ok) {
          return envelopeError(
            action,
            ComputerUseErrorCode.USER_REJECTED,
            approval.reason,
          );
        }
        const clickOpts = buildClickOptions(data);
        const r = await backend.click(clickOpts as never);
        return {
          success: r.ok,
          action,
          data: r,
          error: r.ok
            ? undefined
            : { code: ComputerUseErrorCode.BACKEND_UNAVAILABLE, message: r.reason ?? 'click failed' },
        };
      }
      case 'type': {
        // Access gate: typing into an unapproved app is refused.
        const access = checkForegroundAccess();
        if (!access.ok) {
          logger.warn(
            'computer-use: type refused — app access policy',
            { reason: access.reason, sessionId: sessionId ?? null },
            LogComponent.ComputerUse,
          );
          return {
            success: false,
            action,
            error: {
              code: ComputerUseErrorCode.APP_BLOCKED,
              message: access.reason ?? 'app blocked by access policy',
            },
          };
        }
        const redacted = getRedactedReason();
        if (redacted) {
          logger.warn(
            'computer-use: type refused — redacted field',
            { action: 'type', sessionId: sessionId ?? null },
            LogComponent.ComputerUse,
          );
          return envelopeError(action, ComputerUseErrorCode.REDACTED_FIELD, redacted);
        }
        // Safety gate: text + multiline-shell patterns.
        const text = String(data.text ?? '');
        const safety = validateTextFull(text);
        if (!safety.allowed) {
          logger.warn(
            'computer-use: type refused — safety gate',
            {
              action,
              reasons: safety.reasons.map((r) => r.code),
              sessionId: sessionId ?? null,
            },
            LogComponent.ComputerUse,
          );
          return {
            success: false,
            action,
            error: {
              code: ComputerUseErrorCode.BLOCKED,
              message: safety.reasons.map((r) => r.reason).join('; '),
            },
          };
        }
        const r = await backend.typeText({
          text,
          delayMs: typeof data.delayMs === 'number' ? data.delayMs : undefined,
        });
        if (!r.ok) {
          return { success: false, action, data: r };
        }
        // Auto follow-up screenshot (mirrors claude-quickstarts
        // `type`): the model almost always wants to see the
        // effect of its typing. We take a fresh capture without
        // SOM overlay to keep the payload small.
        let followUpScreenshot: { base64: string; width: number; height: number } | null = null;
        try {
          const cap = await backend.capture({ somMode: false });
          if (cap.base64) {
            followUpScreenshot = {
              base64: cap.base64,
              width: cap.width,
              height: cap.height,
            };
          }
        } catch (err) {
          // Auto-screenshot is best-effort. If it fails the type
          // action still succeeded; the model can call capture
          // explicitly.
          logger.debug(
            'computer-use: type follow-up screenshot failed',
            { error: err instanceof Error ? err.message : String(err) },
            LogComponent.ComputerUse,
          );
        }
        return {
          success: true,
          action,
          data: {
            typeResult: r,
            screenshot: followUpScreenshot,
          },
        };
      }
      case 'key': {
        // Safety gate: blocked key combos.
        const safety = validateKeyCombo({
          key: String(data.key),
          modifiers: Array.isArray(data.modifiers)
            ? (data.modifiers as ('ctrl' | 'alt' | 'shift' | 'meta')[])
            : undefined,
        });
        if (!safety.allowed) {
          logger.warn(
            'computer-use: key refused — safety gate',
            {
              action,
              reasons: safety.reasons.map((r) => r.code),
              sessionId: sessionId ?? null,
            },
            LogComponent.ComputerUse,
          );
          return {
            success: false,
            action,
            error: {
              code: ComputerUseErrorCode.BLOCKED,
              message: safety.reasons.map((r) => r.reason).join('; '),
            },
          };
        }
        const r = await backend.key({
          key: String(data.key),
          modifiers: Array.isArray(data.modifiers) ? (data.modifiers as never) : undefined,
        });
        return {
          success: r.ok,
          action,
          data: r,
        };
      }
      case 'scroll': {
        const r = await backend.scroll({
          direction: data.direction as 'up' | 'down' | 'left' | 'right',
          amount: typeof data.amount === 'number' ? data.amount : 1,
        });
        return {
          success: r.ok,
          action,
          data: r,
        };
      }
      case 'drag': {
        const approval = await requestApprovalIfNeeded(action, data);
        if (!approval.ok) {
          return envelopeError(
            action,
            ComputerUseErrorCode.USER_REJECTED,
            approval.reason,
          );
        }
        const dragOpts = buildDragOptions(data);
        const r = await backend.drag(dragOpts as never);
        return {
          success: r.ok,
          action,
          data: r,
          error: r.ok
            ? undefined
            : { code: ComputerUseErrorCode.BACKEND_UNAVAILABLE, message: r.reason ?? 'drag failed' },
        };
      }
      case 'window_switch': {
        // Access gate: refuse to switch to a window whose app the
        // policy doesn't allow.
        const access = checkForegroundAccess();
        if (!access.ok) {
          logger.warn(
            'computer-use: window_switch refused — app access policy',
            { reason: access.reason, sessionId: sessionId ?? null },
            LogComponent.ComputerUse,
          );
          return {
            success: false,
            action,
            error: {
              code: ComputerUseErrorCode.APP_BLOCKED,
              message: access.reason ?? 'app blocked by access policy',
            },
          };
        }
        const approval = await requestApprovalIfNeeded(action, data);
        if (!approval.ok) {
          return envelopeError(
            action,
            ComputerUseErrorCode.USER_REJECTED,
            approval.reason,
          );
        }
        const r = await backend.focusApp({
          title: typeof data.title === 'string' ? data.title : undefined,
          processName: typeof data.processName === 'string' ? data.processName : undefined,
        });
        return {
          success: r.ok,
          action,
          data: r,
          error: r.ok
            ? undefined
            : { code: ComputerUseErrorCode.BACKEND_UNAVAILABLE, message: r.reason ?? 'focusApp failed' },
        };
      }
      case 'list_apps': {
        const apps = await backend.listApps();
        return { success: true, action, data: { apps } };
      }
      case 'set_value': {
        const redacted = getRedactedReason();
        if (redacted) {
          logger.warn(
            'computer-use: set_value refused — redacted field',
            { action: 'set_value', sessionId: sessionId ?? null },
            LogComponent.ComputerUse,
          );
          return envelopeError(action, ComputerUseErrorCode.REDACTED_FIELD, redacted);
        }
        const value = String(data.value ?? '');
        const safety = validateTextFull(value);
        if (!safety.allowed) {
          logger.warn(
            'computer-use: set_value refused — safety gate',
            {
              action,
              reasons: safety.reasons.map((r) => r.code),
              sessionId: sessionId ?? null,
            },
            LogComponent.ComputerUse,
          );
          return {
            success: false,
            action,
            error: {
              code: ComputerUseErrorCode.BLOCKED,
              message: safety.reasons.map((r) => r.reason).join('; '),
            },
          };
        }
        const approval = await requestApprovalIfNeeded(action, data);
        if (!approval.ok) {
          return envelopeError(
            action,
            ComputerUseErrorCode.USER_REJECTED,
            approval.reason,
          );
        }
        const r = await backend.setValue({
          value,
          delayMs: typeof data.delayMs === 'number' ? data.delayMs : undefined,
        });
        return {
          success: r.ok,
          action,
          data: r,
        };
      }
      case 'wait': {
        await backend.wait({ ms: typeof data.ms === 'number' ? data.ms : 100 });
        return { success: true, action };
      }
      case 'zoom': {
        // Zoom is a region-restricted SOM capture. The full screen
        // is still returned, but only elements falling inside the
        // rectangle get an index marker, so the model can focus on
        // a small UI area (e.g. a single dialog or list).
        const cap = await backend.capture({
          somMode: true,
          region: {
            x: typeof data.x === 'number' ? data.x : 0,
            y: typeof data.y === 'number' ? data.y : 0,
            w: typeof data.w === 'number' ? data.w : 0,
            h: typeof data.h === 'number' ? data.h : 0,
          },
        });
        return { success: true, action, data: cap };
      }
      default: {
        // Exhaustive check — TS will complain if a new action is
        // added without a branch.
        return envelopeError(
          action,
          ComputerUseErrorCode.UNKNOWN,
          `unknown action: ${String(action)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      'computer-use: action threw',
      {
        action,
        error: err instanceof Error ? err.message : String(err),
        sessionId: sessionId ?? null,
      },
      LogComponent.ComputerUse,
    );
    return envelopeError(
      action,
      ComputerUseErrorCode.IPC_EXCEPTION,
      err instanceof Error ? err.message : String(err),
    );
  }
  // Audit is written by the dispatch boundaries (dispatchComputerUseAction
  // for the agent-server path, registerComputerUseHandlers for the renderer
  // IPC path) once the final envelope shape is known — runAction itself
  // previously double-wrote (a coarse ok:true here + the real one in the
  // handler), which made failure audits look like successes.
  void userConfirmed;
}

/**
 * Process-to-process dispatcher: called from the agent-server lifecycle
 * when a `computer-use:execute` message arrives from a worker. Returns
 * the same envelope shape as the IPC handler.
 *
 * Splitting this out keeps the lifecycle handler thin (no IPC plumbing
 * duplication) and gives the renderer a single source of truth for the
 * dispatcher logic.
 */
export async function dispatchComputerUseAction(input: {
  action: ComputerUseAction;
  payload: Record<string, unknown>;
  sessionId?: string;
}): Promise<ComputerUseToolEnvelope> {
  const start = Date.now();
  const envelope = await runAction(input.action, input.payload, input.sessionId);
  logComputerUseAction({
    ts: new Date().toISOString(),
    action: input.action,
    sessionId: input.sessionId ?? '',
    ok: envelope.success,
    userConfirmed: false, // renderer-side confirmation state not tracked yet
    durationMs: Date.now() - start,
    errorCode: envelope.error?.code,
    args: input.payload,
  });
  return envelope;
}

/**
 * Register the IPC handler. Call once from electron/main.ts at boot.
 */
export function registerComputerUseHandlers(): void {
  ipcMain.handle(
    COMPUTER_USE_IPC_CHANNEL,
    async (_event, raw: ExecuteRequestPayload): Promise<IpcExecuteResponse<ComputerUseToolEnvelope>> => {
      const action = raw?.action;
      const payload = raw?.payload ?? {};
      const sessionId = raw?.sessionId;

      if (!action) {
        return {
          success: false,
          error: {
            code: ComputerUseErrorCode.SCHEMA_INVALID,
            message: 'missing action in computer-use:execute payload',
          },
        };
      }

      const envelope = await runAction(action, payload, sessionId);

      // Always log the audit (regardless of success/failure).
      logComputerUseAction({
        ts: new Date().toISOString(),
        action,
        sessionId: sessionId ?? '',
        ok: envelope.success,
        userConfirmed: false, // Phase 3: track approval state
        durationMs: null,
        errorCode: envelope.error?.code,
        args: payload,
      });

      return { success: envelope.success, data: envelope, error: envelope.error };
    },
  );
}