/**
 * mcp/cua-driver.ts — McpCuaDriverBackend (plan 519 §3.1 / D1).
 *
 * A DesktopBackend implementation that delegates desktop control to a
 * `cua-driver` MCP server over stdio. This is the cross-platform
 * escape hatch: on macOS / Linux (and whenever `DUYA_CUA_DRIVER=external`
 * is set) we do NOT hand-roll a per-OS FFI backend — we speak the MCP
 * protocol to an existing driver process instead.
 *
 * Windows keeps `ElectronDesktopBackend` (native nut.js + desktopCapturer,
 * no stdio roundtrip) per plan decision #6. This class is the MCP path.
 *
 * Protocol: the driver exposes one MCP tool per DesktopBackend method
 * (`capture`, `click`, `drag`, `scroll`, `type_text`, `key`, `list_apps`,
 * `focus_app`, `set_value`, `wait`). Tool results are parsed back into
 * the duya types by `mcp/result-parser.ts`. Read-back verdicts flow
 * through the same `ActionResult.verdict` lane as the Electron backend,
 * so the tool layer sees a uniform surface regardless of backend.
 *
 * All MCP calls go through the injectable `CallTool` bound so unit tests
 * can mock the driver over an in-memory transport. No Python dependency
 * is introduced into this package — the driver binary is external.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  ActionResult,
  AppInfo,
  CaptureOptions,
  CaptureResult,
  ClickOptions,
  DesktopBackend,
  DragOptions,
  FocusAppOptions,
  KeyOptions,
  ScrollOptions,
  SetValueOptions,
  TypeTextOptions,
} from '../types.js';
import { parseActionResult, parseCaptureResult, parseListApps } from './result-parser.js';

/** Mapping from DesktopBackend method to the driver's MCP tool name. */
export const CUA_TOOL_NAME = {
  capture: 'computer_use_capture',
  click: 'computer_use_click',
  drag: 'computer_use_drag',
  scroll: 'computer_use_scroll',
  typeText: 'computer_use_type_text',
  key: 'computer_use_key',
  listApps: 'computer_use_list_apps',
  focusApp: 'computer_use_focus_app',
  setValue: 'computer_use_set_value',
  wait: 'computer_use_wait',
} as const;

export type CuaToolNameMap = typeof CUA_TOOL_NAME;

/**
 * Promise-based MCP tool call. Extracted so tests can bind it to a stub
 * client instead of a real spawned driver.
 */
export type CallTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

/** Result of a driver tool call: `{ content: [{ type: 'text', text: string }] }`. */
export interface McpToolResultContent {
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

/**
 * Options to construct McpCuaDriverBackend. Always inject the call-bound
 * in production; tests pass a stub.
 */
export interface McpCuaDriverOptions {
  /** Stdio parameters for the driver (command + args). */
  server?: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
  /**
   * Tool-call surface. Defaults to spawning the driver via stdio; tests
   * override this with an in-memory client to avoid a real process.
   */
  callTool?: CallTool;
  /** Override the tool-name mapping (dual with mock driver naming). */
  toolNames?: CuaToolNameMap;
  /** Read a focused entity for verdict (mirrors Electron backend). Optional. */
  readFocusedEntity?: () => Promise<unknown> | unknown;
}

/**
 * MCP-backed desktop backend. Delegates every action to the driver by
 * name per `CuaToolNameMap`, and parses MCP results back into the duya
 * type surface.
 */
export class McpCuaDriverBackend implements DesktopBackend {
  readonly id: string;
  private readonly call: CallTool;
  private readonly names: CuaToolNameMap;
  private readonly client: Client | null = null;
  private readonly transport: StdioClientTransport | null = null;
  private readonly server?: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
  private readonly readFocusedEntity?: () => Promise<unknown> | unknown;

  constructor(opts: McpCuaDriverOptions = {}) {
    this.names = opts.toolNames ?? CUA_TOOL_NAME;
    this.id = 'mcp-cua-driver';
    this.server = opts.server;
    this.readFocusedEntity = opts.readFocusedEntity;
    if (opts.callTool) {
      this.call = opts.callTool;
    } else {
      if (!opts.server?.command) {
        throw new Error('McpCuaDriverBackend: missing server.command (no callTool, no spawn config)');
      }
      this.transport = new StdioClientTransport({
        command: opts.server.command,
        args: opts.server.args,
        env: opts.server.env,
        cwd: opts.server.cwd,
        stderr: 'pipe',
      });
      this.client = new Client({ name: 'duya-computer-use', version: '0.0.1' });
      this.call = this.makeDriverCall(this.client, this.transport);
    }
  }

  /** Start the stdio client (no-op when callTool injected). */
  async connect(): Promise<void> {
    if (this.client && this.transport) {
      await this.client.connect(this.transport);
    }
  }

  /** Stop the stdio client (no-op when callTool injected). */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }

  async capture(opts?: CaptureOptions): Promise<CaptureResult> {
    const result = await this.call(
      this.names.capture,
      opts ? { ...opts } : {},
    );
    return parseCaptureResult(result as McpToolResultContent);
  }

  async click(opts: ClickOptions): Promise<ActionResult> {
    return this.action('click', opts);
  }

  async drag(opts: DragOptions): Promise<ActionResult> {
    return this.action('drag', opts);
  }

  async scroll(opts: ScrollOptions): Promise<ActionResult> {
    return this.action('scroll', opts);
  }

  async typeText(opts: TypeTextOptions): Promise<ActionResult> {
    return this.action('typeText', opts);
  }

  async key(opts: KeyOptions): Promise<ActionResult> {
    return this.action('key', opts);
  }

  async listApps(): Promise<AppInfo[]> {
    const result = await this.call(this.names.listApps, {});
    return parseListApps(result as McpToolResultContent);
  }

  async focusApp(opts: FocusAppOptions): Promise<ActionResult> {
    return this.action('focusApp', opts);
  }

  async setValue(opts: SetValueOptions): Promise<ActionResult> {
    return this.action('setValue', opts);
  }

  async wait(opts: { ms: number }): Promise<void> {
    // `wait` returns a bare Ok/void — we parse ok-ness but ignore the body.
    await this.call(this.names.wait, { ms: opts.ms });
  }

  private async action(method: keyof CuaToolNameMap, opts: unknown): Promise<ActionResult> {
    const result = await this.call(this.names[method], opts as Record<string, unknown>);
    return parseActionResult(result as McpToolResultContent);
  }

  /**
   * Bind a real SDK client to a stdio transport, returning a `CallTool`.
   */
  private makeDriverCall(client: Client, transport: StdioClientTransport): CallTool {
    return async (toolName: string, input: Record<string, unknown>): Promise<unknown> => {
      const res = await client.callTool({
        name: toolName,
        arguments: input,
      });
      return res as unknown;
    };
  }
}