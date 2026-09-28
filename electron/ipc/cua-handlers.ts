/**
 * ipc/cua-handlers.ts — CUA tool channel (plan 575).
 *
 * Transport for the `computer_cua` agent tool: the worker sends
 * `computer-use:cua` over the tool bridge (routed by
 * agent-server-lifecycle) or the renderer invokes it over IPC; both
 * land in `dispatchCuaTool`, which owns the shared CuaService singleton
 * with its electron-backed deps (clipboard + desktopCapturer window
 * capture) and returns the aligned envelope.
 *
 * Envelope discipline: every CuaError becomes a typed envelope error
 * with its CUA error code — the tool executor never sees a bare throw.
 * Non-win32 platforms answer STRUCTURED_STATE_UNAVAILABLE (plan 575
 * scope red line: only the Windows channel is implemented here).
 */

import { clipboard, desktopCapturer } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  CuaError,
  buildArgsPreview,
  getDefaultApprovalBridge,
  type CuaActionReceipt,
  type CuaObservation,
  type CuaAppInfo,
  type CuaWindowInfo,
} from '@duya/computer-use';

import { getLogger, LogComponent } from '../logging/logger.js';
import { assertComputerUseAllowed } from '../services/computer-use-guard.js';
import { CuaService, type CuaAppRef } from '../services/cua/cua-service.js';
import { restoreWindowWithoutFocus } from '../services/cua/window-restore.js';

const logger = getLogger();

export const CUA_IPC_CHANNEL = 'computer-use:cua';

/** One dispatch request: which of the 14 tools + its args. */
export interface CuaDispatchRequest {
  tool: string;
  args?: Record<string, unknown>;
  sessionId?: string;
}

export interface CuaEnvelope<T = unknown> {
  success: boolean;
  tool: string;
  data?: T;
  error?: { code: string; message: string };
}

/** Largest thumbnail edge we will request (bounds are physical px). */
const MAX_THUMBNAIL_EDGE = 2560;

/**
 * Blank-frame detection (plan 575 gap fix — ZCode's inspectPngContent /
 * screenshot_blank): a uniform PNG (every channel stddev ≈ 0) is an
 * occluded/minimized/protected surface, not a usable frame. Best-effort:
 * when sharp is unavailable the check degrades to undefined (frame kept).
 */
async function detectBlankPng(base64: string): Promise<boolean | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp') as (
      input: Buffer,
    ) => { stats(): Promise<{ channels: Array<{ stdev?: number; stddev?: number }> }> };
    const stats = await sharp(Buffer.from(base64, 'base64')).stats();
    const maxStddev = Math.max(
      ...stats.channels.map((ch) => ch.stdev ?? ch.stddev ?? 0),
    );
    return maxStddev < 1.0;
  } catch {
    return undefined;
  }
}

/**
 * Electron-backed window capture: desktopCapturer window sources.
 * The thumbnail is requested at the window's own physical size (capped)
 * so the aspect ratio matches and coordinate mapping loses no fidelity —
 * a fixed 1280x800 request letterboxes mismatched windows (plan 575
 * gap fix).
 */
async function captureWindow(
  windowId: number | null,
  bounds?: [number, number, number, number] | null,
): Promise<{ base64: string; width: number; height: number; blank?: boolean } | null> {
  try {
    const clamp = (v: number) => Math.max(1, Math.min(MAX_THUMBNAIL_EDGE, Math.round(v)));
    const thumbnailSize =
      bounds && bounds[2] > 0 && bounds[3] > 0
        ? { width: clamp(bounds[2]), height: clamp(bounds[3]) }
        : { width: 1280, height: 800 };
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      fetchWindowIcons: false,
      thumbnailSize,
    });
    let source = null;
    if (windowId !== null) {
      // Chromium window source ids carry the native handle as the middle
      // field: "window:<hwnd>:<instance>".
      source = sources.find((s) => s.id.startsWith(`window:${windowId}:`)) ?? null;
    } else if (sources.length > 0) {
      source = sources[0];
    }
    if (!source || source.thumbnail.isEmpty()) return null;
    const size = source.thumbnail.getSize();
    const base64 = (await source.thumbnail.toPNG()).toString('base64');
    const blank = await detectBlankPng(base64);
    return {
      base64,
      width: size.width,
      height: size.height,
      ...(blank !== undefined ? { blank } : {}),
    };
  } catch (err) {
    logger.warn(
      'cua: window capture failed',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
    return null;
  }
}

let sharedService: CuaService | null = null;

/**
 * plan 578 smoke fix: the agent-tool schema exposes the app_ref as
 * TOP-LEVEL pid/name/windowId fields, while the service action methods
 * read a nested `appRef` object. Translate here — before this fix every
 * element action reached the service with app_ref = {} and failed with
 * ELEMENT_UNAVAILABLE "no observation for this app_ref yet", no matter
 * what the model passed (real-machine smoke 2026-09-28).
 */
function toAppRef(args: Record<string, unknown>): CuaAppRef | undefined {
  const ref: CuaAppRef = {};
  if (typeof args.pid === 'number' && args.pid > 0) ref.pid = args.pid;
  if (typeof args.name === 'string' && args.name.trim()) ref.name = args.name;
  if (typeof args.windowId === 'number' && args.windowId > 0) ref.windowId = args.windowId;
  return Object.keys(ref).length > 0 ? ref : undefined;
}

function getService(): CuaService {
  if (sharedService === null) {
    sharedService = new CuaService({
      writeClipboard: (text: string) => clipboard.writeText(text),
      capture: (windowId, bounds) => captureWindow(windowId, bounds),
      // plan 578: a screenshot-bearing get_app_state on a minimized
      // window restores it first (SW_SHOWNOACTIVATE — no focus steal),
      // ZCode's "include_screenshot un-minimizes" parity.
      restoreWindow: (windowId) => restoreWindowWithoutFocus(windowId),
      // plan 575 follow-up: CUA rides the SAME execution guard as the
      // vision surface — one implementation of the revoke gate (overlay
      // STOP) + the [computer_use] app-access policy. Decisions are
      // shared; the CUA envelope maps them onto NOT_AUTHORIZED /
      // PERMISSION_DENIED inside the service.
      guard: (input) => assertComputerUseAllowed(input),
      // plan 575 red line: mutating CUA tools ride the SAME user-
      // confirmation channel as the classic computer_use surface —
      // the shared ApprovalBridge (same bridge the requestApprovalIfNeeded
      // gate in ipc/computer-use.ts uses).
      approval: async (tool, args) => {
        const bridge = getDefaultApprovalBridge();
        const req = {
          requestId: randomUUID(),
          action: tool,
          argsPreview: buildArgsPreview(args),
          issuedAt: new Date().toISOString(),
          timeoutMs: 3_000,
        };
        try {
          const result = await bridge.requestApproval(req);
          if (result.approved) return { ok: true };
          const reason =
            result.reason === 'timeout'
              ? `approval timed out after ${req.timeoutMs}ms`
              : `user denied the action (${result.reason})`;
          logger.info(
            'cua: action not approved',
            { tool, requestId: req.requestId, reason: result.reason },
            LogComponent.ComputerUse,
          );
          return { ok: false, reason };
        } catch (err) {
          return {
            ok: false,
            reason: `approval bridge error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });
  }
  return sharedService;
}

/** Test hook: forget the singleton (deps are not injectable across files). */
export function __resetCuaService(): void {
  sharedService = null;
}

type CuaResult = CuaObservation | CuaActionReceipt | CuaAppInfo[] | CuaWindowInfo[] | Record<string, unknown> | null;

/** Dispatch one CUA tool call. Never throws — failures are envelopes. */
export async function dispatchCuaTool(input: CuaDispatchRequest): Promise<CuaEnvelope> {
  const tool = input.tool;
  const args = input.args ?? {};
  const sessionId = input.sessionId;
  try {
    if (process.platform !== 'win32') {
      throw new CuaError('the CUA channel is currently implemented on Windows only', {
        code: 'STRUCTURED_STATE_UNAVAILABLE',
      });
    }
    const service = getService();
    // The agent tool zod-validates its input before dispatching; the
    // renderer path re-validates only via these casts — the service
    // itself re-checks the critical invariants (target shape, bounds).
    type Svc = CuaService;
    let data: CuaResult;
    switch (tool) {
      case 'list_apps':
        data = await service.listApps();
        break;
      case 'list_windows':
        data = await service.listWindows(typeof args.pid === 'number' ? args.pid : undefined);
        break;
      case 'get_app_state': {
        const out = await service.getAppState(
          {
            pid: typeof args.pid === 'number' ? args.pid : undefined,
            name: typeof args.name === 'string' ? args.name : undefined,
            windowId: typeof args.windowId === 'number' ? args.windowId : undefined,
            includeScreenshot: args.includeScreenshot === true,
            maxElements: typeof args.maxElements === 'number' ? args.maxElements : undefined,
            fresh: args.fresh === true,
          },
          sessionId,
        );
        data = { observation: out.observation, text: out.text, screenshot: out.screenshot };
        break;
      }
      case 'left_click':
        data = await service.leftClick(
          { ...(args as Parameters<Svc['leftClick']>[0]), appRef: toAppRef(args) },
          sessionId,
        );
        break;
      case 'left_click_drag':
        data = await service.leftClickDrag(
          { ...(args as Parameters<Svc['leftClickDrag']>[0]), appRef: toAppRef(args) },
          sessionId,
        );
        break;
      case 'scroll':
        data = await service.scroll(args as Parameters<Svc['scroll']>[0], sessionId);
        break;
      case 'type':
        data = await service.typeText(args as Parameters<Svc['typeText']>[0], sessionId);
        break;
      case 'key':
        data = await service.key(args as Parameters<Svc['key']>[0], sessionId);
        break;
      case 'set_value':
        data = await service.setValue(
          { ...(args as Parameters<Svc['setValue']>[0]), appRef: toAppRef(args) },
          sessionId,
        );
        break;
      case 'select_text':
        data = await service.selectText(
          { ...(args as Parameters<Svc['selectText']>[0]), appRef: toAppRef(args) },
          sessionId,
        );
        break;
      case 'perform_action':
        data = await service.performAction(
          { ...(args as Parameters<Svc['performAction']>[0]), appRef: toAppRef(args) },
          sessionId,
        );
        break;
      case 'paste':
        data = await service.paste(args as Parameters<Svc['paste']>[0], sessionId);
        break;
      case 'request_access':
        data = await service.requestAccess();
        break;
      case 'stop_computer_control':
        service.stop(sessionId);
        data = { stopped: true };
        break;
      default:
        throw new CuaError(`unknown CUA tool ${JSON.stringify(tool)}`, { code: 'INVALID_APP' });
    }
    return { success: true, tool, data };
  } catch (err) {
    if (err instanceof CuaError) {
      return {
        success: false,
        tool,
        error: { code: err.code, message: err.message },
      };
    }
    logger.error(
      'cua: dispatch threw unexpectedly',
      err instanceof Error ? err : undefined,
      { tool },
      LogComponent.ComputerUse,
    );
    return {
      success: false,
      tool,
      error: {
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Register the renderer-facing IPC handler. Call once from main.ts;
 * the worker path goes through agent-server-lifecycle instead.
 */
export function registerCuaHandlers(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require('electron') as typeof import('electron');
  ipcMain.handle(CUA_IPC_CHANNEL, async (_event, raw: CuaDispatchRequest | undefined) => {
    if (!raw || typeof raw.tool !== 'string') {
      return {
        success: false,
        tool: String(raw?.tool ?? ''),
        error: { code: 'INVALID_APP', message: 'missing tool in computer-use:cua payload' },
      } satisfies CuaEnvelope;
    }
    return dispatchCuaTool({ tool: raw.tool, args: raw.args, sessionId: raw.sessionId });
  });
}
