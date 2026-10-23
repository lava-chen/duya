/**
 * ax-helper-protocol.ts — wire contract between the Electron main
 * process and the resident Swift AX helper (plan 572, Phase 0).
 *
 * The helper is a Swift CLI (`resources/ax-helper/`) speaking one JSON
 * line per request over stdin, one JSON line per response (plus
 * heartbeats) over stdout — the same shape as the PowerShell UIA probe
 * (uia-probe-protocol.ts), so the daemon spawn/heartbeat/recycle
 * pipeline carries it unchanged.
 *
 * Requests (main → helper stdin):
 *   {"id":1,"op":"ping"}
 *   {"id":2,"op":"permissions"}
 *   {"id":3,"op":"apps"}
 *   {"id":4,"op":"fg"}
 *   {"id":5,"op":"secureInput"}
 *   {"id":6,"op":"windows","pid":123}
 *   {"id":7,"op":"enumerate","pid":123,"maxDepth":40,"maxNodes":500,"roles":[...]}
 *   {"id":8,"op":"probe","x":123,"y":456}
 *   {"id":9,"op":"action","pid":123,"handle":"h12","action":"AXPress"}
 *   {"id":10,"op":"setValue","pid":123,"handle":"h12","value":"text"}
 *   {"id":11,"op":"readUrl","pid":123,"app":"Google Chrome"}
 *   {"id":12,"op":"manualAccessibility","pid":123}
 *   {"id":13,"op":"keyToPid","pid":123,"vk":36,"flags":["cmd"]}
 *   {"id":14,"op":"scrollToPid","pid":123,"ticks":3,"direction":"up"}
 *   {"id":15,"op":"activate","pid":123}
 *   {"id":16,"op":"screenshotWindow","windowId":123}
 *
 * Responses (helper stdout):
 *   {"ready":true}                          — first line after launch
 *   {"type":"heartbeat"}                    — every 30s (daemon dead-man)
 *   {"id":1,"ok":true,...}                  — op-specific payload
 *   {"id":2,"ok":false,"error":{"code":"permission-denied","message":"..."}}
 *
 * Every op that touches the AX API can fail with `permission-denied`
 * (the app bundle is not in the Accessibility TCC list) — the client
 * surfaces that as a structured error so the UI can guide the user
 * instead of silently degrading.
 *
 * This module is pure data (zod parse/build helpers only) so both the
 * main-side client and the tests run without electron.
 */

import { z } from 'zod';

import { ElementDescriptorSchema } from './events.js';
import type { ElementDescriptor } from './events.js';

/** Helper operations the main side builds. */
export interface AxHelperRequest {
  id: number;
  op:
    | 'ping'
    | 'permissions'
    | 'apps'
    | 'fg'
    | 'secureInput'
    | 'windows'
    | 'enumerate'
    | 'probe'
    | 'action'
    | 'setValue'
    | 'readUrl'
    | 'manualAccessibility'
    | 'keyToPid'
    | 'scrollToPid'
    | 'activate'
    | 'screenshotWindow';
  pid?: number;
  windowId?: number;
  x?: number;
  y?: number;
  handle?: string;
  action?: string;
  value?: string;
  app?: string;
  vk?: number;
  flags?: string[];
  ticks?: number;
  direction?: 'up' | 'down';
  maxDepth?: number;
  maxNodes?: number;
  /** enumerate: interactive AX-role override (helper default when absent). */
  roles?: string[];
}

/**
 * Interactive AX-role whitelist (plan 572 Phase 0). Only elements whose
 * `kAXRoleAttribute` is in this list become enumerate nodes; traversal
 * still walks *through* every other element to reach interactive
 * descendants inside containers. Mirrors the UIA ControlType whitelist
 * semantics from plan 562.
 */
export const DEFAULT_INTERACTIVE_AX_ROLES: readonly string[] = [
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXMenuItem',
  'AXTextField',
  'AXSecureField',
  'AXTextArea',
  'AXComboBox',
  'AXSlider',
  'AXLink',
  'AXRow',
  'AXStaticText',
];

/**
 * AX role → UIA ControlType mapping. The macOS helper reports raw AX
 * roles; mapping them to the UIA vocabulary lets the shared downstream
 * consumers (element-detector kind mapping, matcher, overlay whitelist)
 * work without platform branches.
 */
export const AX_ROLE_TO_CONTROL_TYPE: Readonly<Record<string, string>> = {
  AXButton: 'Button',
  AXCheckBox: 'CheckBox',
  AXRadioButton: 'RadioButton',
  AXPopUpButton: 'ComboBox',
  AXMenuButton: 'Button',
  AXMenuItem: 'MenuItem',
  AXMenuBarItem: 'MenuItem',
  AXTextField: 'Edit',
  AXSecureField: 'Edit',
  AXTextArea: 'Document',
  AXComboBox: 'ComboBox',
  AXSlider: 'Slider',
  AXLink: 'Hyperlink',
  AXStaticText: 'Text',
  AXImage: 'Image',
  AXTabGroup: 'TabItem',
  AXRow: 'ListItem',
  AXTable: 'Table',
  AXOutline: 'Table',
  AXList: 'List',
  AXMenu: 'Menu',
  AXGroup: 'Group',
  AXToolbar: 'ToolBar',
  AXWindow: 'Window',
  AXApplication: 'Window',
  AXScrollArea: 'Pane',
  AXSplitGroup: 'Pane',
};

/** Map a raw AX role to the UIA ControlType vocabulary (best-effort). */
export function axRoleToControlType(role: string | undefined): string {
  if (!role) return 'Control';
  return AX_ROLE_TO_CONTROL_TYPE[role] ?? role.replace(/^AX/, '');
}

/**
 * Wire shape of one enumerate/probe element: the recorder's descriptor
 * fields minus provenance (stamped on the client side) plus the AX
 * identity fields the helper adds.
 */
const AxElementWireSchema = ElementDescriptorSchema.omit({ source: true }).extend({
  /** Raw AX role, e.g. "AXButton" / "AXSecureField". */
  role: z.string().optional(),
  subrole: z.string().optional(),
  /** Snapshot handle ("h:<n>") for AX-action delivery. */
  handle: z.string().optional(),
  /** Action names reported by the element, e.g. ["AXPress","AXConfirm"]. */
  actions: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
});

export type AxEnumeratedElement = ElementDescriptor & {
  role?: string;
  subrole?: string;
  handle?: string;
  actions?: string[];
  interactive?: boolean;
};

/** One running app from the `apps` op (NSWorkspace-backed). */
export interface AxAppInfo {
  pid: number;
  name: string;
  bundleId?: string | null;
  isActive?: boolean;
}

/** One window from the `windows` op (CGWindowList-backed, layer 0). */
export interface AxWindowInfo {
  windowId: number;
  pid: number;
  ownerName?: string;
  title?: string;
  bounds: { x: number; y: number; w: number; h: number };
}

/** fg op payload — shape-compatible with the recorder's ForegroundWindowInfo. */
export interface AxForegroundInfo {
  /** CGWindowID of the frontmost on-screen window (0 when unresolvable). */
  windowId: number;
  pid: number;
  processName: string;
  title: string;
}

/** TCC + system state snapshot from the `permissions` op. */
export interface AxPermissionSnapshot {
  /** kTCCServiceAccessibility — required for every AX/CGEventPost call. */
  accessibility: 'granted' | 'denied' | 'not-determined';
  /** kTCCServiceScreenCapture — window titles + screen capture. */
  screen: 'granted' | 'denied' | 'not-determined';
  /** kTCCServiceListenEvent — Input Monitoring (listen taps). */
  listen: 'granted' | 'denied' | 'not-determined';
  /** PID holding Secure Input, or null when off (kCGSSessionSecureInputPID). */
  secureInputPid?: number | null;
}

/** Structured helper error (transport + protocol level). */
export type AxHelperErrorCode =
  | 'permission-denied'
  | 'timeout'
  | 'stale-handle'
  | 'unsupported'
  | 'not-settable'
  | 'applescript-denied'
  | 'no-url'
  | 'error';

export interface AxHelperError {
  code: AxHelperErrorCode;
  message: string;
}

const PermissionStateSchema = z.enum(['granted', 'denied', 'not-determined']);

const successPayloadSchema = z.object({
  apps: z
    .array(
      z.object({
        pid: z.number(),
        name: z.string(),
        bundleId: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .optional(),
  windows: z
    .array(
      z.object({
        windowId: z.number(),
        pid: z.number(),
        ownerName: z.string().optional(),
        title: z.string().optional(),
        bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      }),
    )
    .optional(),
  fg: z
    .object({
      windowId: z.number(),
      pid: z.number(),
      processName: z.string(),
      title: z.string(),
    })
    .optional(),
  permissions: z
    .object({
      accessibility: PermissionStateSchema,
      screen: PermissionStateSchema,
      listen: PermissionStateSchema,
      secureInputPid: z.number().nullable().optional(),
    })
    .optional(),
  secureInput: z
    .object({ enabled: z.boolean(), pid: z.number().nullable().optional() })
    .optional(),
  element: AxElementWireSchema.nullable().optional(),
  elements: z.array(AxElementWireSchema).optional(),
  truncated: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  performed: z.boolean().optional(),
  set: z.boolean().optional(),
  activated: z.boolean().optional(),
  manualAccessibility: z.boolean().optional(),
  png: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const failureSchema = z.object({
  id: z.number().int(),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
  }),
});

const successSchema = z.object({
  id: z.number().int(),
  ok: z.literal(true),
});

const readySchema = z.object({ ready: z.literal(true) });
const heartbeatSchema = z.object({ type: z.literal('heartbeat') });

export type AxHelperResponse =
  | { kind: 'ready' }
  | { kind: 'heartbeat' }
  | {
      kind: 'response';
      id: number;
      ok: true;
      data: {
        apps: AxAppInfo[] | null;
        windows: AxWindowInfo[] | null;
        fg: AxForegroundInfo | null;
        permissions: AxPermissionSnapshot | null;
        secureInput: { enabled: boolean; pid?: number | null } | null;
        element: AxEnumeratedElement | null;
        elements: AxEnumeratedElement[] | null;
        truncated: boolean;
        reason: string | null;
        url: string | null;
        performed: boolean;
        set: boolean;
        activated: boolean;
        manualAccessibility: boolean;
        png: string | null;
        width: number | null;
        height: number | null;
      };
    }
  | { kind: 'response'; id: number; ok: false; error: AxHelperError };

/** Build one request line (single JSON line, trailing newline added by caller). */
export function buildAxRequestLine(request: AxHelperRequest): string {
  return JSON.stringify(request);
}

/**
 * Parse one stdout line from the helper. Returns null for anything that
 * is not a valid protocol line (the caller logs and drops it).
 */
export function parseAxHelperLine(line: string): AxHelperResponse | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (readySchema.safeParse(raw).success) return { kind: 'ready' };
  if (heartbeatSchema.safeParse(raw).success) return { kind: 'heartbeat' };
  const failure = failureSchema.safeParse(raw);
  if (failure.success) {
    return {
      kind: 'response',
      id: failure.data.id,
      ok: false,
      error: {
        code: (failure.data.error.code ?? 'error') as AxHelperErrorCode,
        message: failure.data.error.message ?? '',
      },
    };
  }
  const success = successSchema.safeParse(raw);
  if (success.success) {
    const payload = successPayloadSchema.safeParse(raw);
    if (!payload.success) return null;
    const d = payload.data;
    return {
      kind: 'response',
      id: success.data.id,
      ok: true,
      data: {
        apps: d.apps ?? null,
        windows: d.windows ?? null,
        fg: d.fg ?? null,
        permissions: d.permissions ?? null,
        secureInput: d.secureInput ?? null,
        element: (d.element ?? null) as AxEnumeratedElement | null,
        elements: (d.elements ?? null) as AxEnumeratedElement[] | null,
        truncated: d.truncated ?? false,
        reason: d.reason ?? null,
        url: d.url ?? null,
        performed: d.performed ?? false,
        set: d.set ?? false,
        activated: d.activated ?? false,
        manualAccessibility: d.manualAccessibility ?? false,
        png: d.png ?? null,
        width: d.width ?? null,
        height: d.height ?? null,
      },
    };
  }
  return null;
}

/**
 * Map a helper element payload to the recorder's ElementDescriptor
 * (provenance `ax-helper`, AX role mapped to the UIA ControlType
 * vocabulary, secure fields flagged from the raw role). `null` decodes
 * to `{ source: 'none' }` so callers never distinguish "no element"
 * from "bad payload".
 */
export function axElementToDescriptor(element: unknown): ElementDescriptor {
  if (element === null || element === undefined) {
    return { source: 'none' };
  }
  const parsed = AxElementWireSchema.safeParse(element);
  if (!parsed.success) {
    return { source: 'none' };
  }
  const wire = parsed.data;
  const role = wire.role ?? '';
  const isPassword = wire.isPassword === true || role === 'AXSecureField';
  const controlType = wire.controlType ?? axRoleToControlType(role || undefined);
  const descriptor: ElementDescriptor = {
    ...(wire.name !== undefined ? { name: wire.name } : {}),
    controlType,
    ...(wire.automationId !== undefined ? { automationId: wire.automationId } : {}),
    ...(wire.className !== undefined ? { className: wire.className } : {}),
    ...(wire.rect !== undefined ? { rect: wire.rect } : {}),
    ...(isPassword ? { isPassword: true } : {}),
    ...(wire.handle !== undefined ? { handle: wire.handle } : {}),
    source: 'ax-helper',
  };
  return descriptor;
}

/** Map one enumerate element, preserving the handle + interactive flag. */
export function axEnumeratedToDescriptor(element: unknown): AxEnumeratedElement | null {
  const parsed = AxElementWireSchema.safeParse(element);
  if (!parsed.success) return null;
  const wire = parsed.data;
  const role = wire.role ?? '';
  const isPassword = wire.isPassword === true || role === 'AXSecureField';
  const controlType = wire.controlType ?? axRoleToControlType(role || undefined);
  return {
    ...(wire.name !== undefined ? { name: wire.name } : {}),
    controlType,
    ...(wire.automationId !== undefined ? { automationId: wire.automationId } : {}),
    ...(wire.className !== undefined ? { className: wire.className } : {}),
    ...(wire.rect !== undefined ? { rect: wire.rect } : {}),
    ...(isPassword ? { isPassword: true } : {}),
    ...(wire.handle !== undefined ? { handle: wire.handle } : {}),
    ...(wire.actions !== undefined ? { actions: wire.actions } : {}),
    ...(wire.interactive !== undefined ? { interactive: wire.interactive } : {}),
    source: 'ax-helper',
  };
}

/**
 * True when the process name looks like a supported browser. Windows
 * process names are executable names ("chrome", "msedge"); macOS
 * NSRunningApplication names are the localized product names
 * ("Google Chrome", "Safari", "Microsoft Edge", ...). Matching is
 * exact against both vocabularies so a Windows process never
 * accidentally matches a macOS name and vice versa.
 */
const MAC_BROWSER_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'safari',
  'google chrome',
  'chrome',
  'microsoft edge',
  'msedge',
  'brave browser',
  'brave',
  'arc',
  'edge',
  'firefox',
  'vivaldi',
  'opera',
  'dia',
]);

export function isMacBrowserProcess(processName: string): boolean {
  return MAC_BROWSER_PROCESS_NAMES.has(processName.trim().toLowerCase());
}

/**
 * AppleScript dictionary command for reading the active-tab URL of a
 * supported browser. Returns null for unknown apps — the caller then
 * skips the read instead of firing a blind `tell` that would trigger a
 * pointless Apple Events permission prompt.
 */
export function browserUrlAppleScript(app: string): string | null {
  const name = app.trim().toLowerCase();
  if (name === 'safari') {
    return 'tell application "Safari" to if (count of documents) > 0 then get URL of front document';
  }
  // Chromium family ships the same dictionary: Chrome, Edge, Brave, Arc, Vivaldi.
  const chromium: Record<string, string> = {
    'google chrome': 'Google Chrome',
    chrome: 'Google Chrome',
    'microsoft edge': 'Microsoft Edge',
    msedge: 'Microsoft Edge',
    edge: 'Microsoft Edge',
    'brave browser': 'Brave Browser',
    brave: 'Brave Browser',
    arc: 'Arc',
    vivaldi: 'Vivaldi',
    opera: 'Opera',
    firefox: '',
    dia: '',
  };
  const target = chromium[name];
  if (!target) return null;
  return (
    `tell application "${target}" to if (count of windows) > 0 then get URL of active tab of front window`
  );
}
