/**
 * orb-wakeless-chat.ts — wire orb submit → wakeless agent session.
 *
 * Plan 453 Task G. The orb submits a prompt; this module:
 *   1. Builds a synthetic sessionId (`wakeless-<uuid>`).
 *   2. Resolves the user's active provider config (same source as the
 *      main window's chat: ProviderStore, unmasked, with runtimeConfig).
 *   3. POSTs to the agent server (`POST /sessions/:id/chat`, SSE) with
 *      `options.wakeless = true` so the worker skips journal
 *      persistence (see agent-process-entry.ts).
 *   4. Parses the SSE stream and forwards it to the orb renderer via
 *      the `automation:orb:*` IPC: text deltas → chunk, tool starts →
 *      progress bubble, done → result card.
 *
 * Context injection: when the OSContextBridge is enabled (the bridge
 * arms when the orb wakes), the focused window's title/selection/text
 * is prepended to the prompt and a screen thumbnail is attached as an
 * image file — the same `files` channel the conductor uses. Both are
 * best-effort: no bridge snapshot or capture failure just means a
 * plain-prompt turn.
 *
 * Why we go through the HTTP/SSE pipeline (not a direct worker
 * command): the agent server owns worker lifecycle, lazy spawn,
 * routing and the concurrency lock — POST /sessions/:id/chat
 * lazy-spawns and inits the worker for the synthetic session exactly
 * like any other chat.
 */

import { desktopCapturer, screen, type DesktopCapturerSource } from 'electron';
import { randomUUID } from 'node:crypto';

import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getLogger, LogComponent } from '../logging/logger';
import {
  sendOrbChunk,
  sendOrbHide,
  sendOrbProgress,
  sendOrbResult,
} from '../ipc/orb';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { toLLMProvider, type ApiProvider } from '../config/provider-types';
import { toLegacyApiProvider } from '../../src/lib/providers/legacy';
import { toRuntimeConfig as buildRuntimeConfig } from '../../src/lib/providers';
import { getOSContextBridge } from '../../packages/agent/dist/context/os-context/index.js';
import { getSetting } from '../db/queries/settings';

const logger = getLogger();

/** Hard cap on the wakeless session lifetime (ms). */
export const WAKELESS_TIMEOUT_MS = 5 * 60 * 1000;

/** Gaze-reference for the screenshot thumbnail's long edge (px). */
const SCREENSHOT_MAX_EDGE = 1280;

export interface WakelessChatResult {
  accepted: boolean;
  sessionId?: string;
  note?: string;
}

/**
 * Build a fresh `wakeless-<uuid>` sessionId. Exported so tests can
 * verify the prefix and uniqueness property without touching the
 * HTTP layer.
 */
export function newWakelessSessionId(): string {
  return `wakeless-${randomUUID()}`;
}

/**
 * Build a unique turnId for one chat invocation. Used to tag
 * `automation:orb:chunk` deltas so the renderer can dedup across
 * reconnects.
 */
export function newWakelessTurnId(): string {
  return `wake-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Provider resolution (mirrors agent-communicator's
// config:provider:getActiveProviderConfig handler — same store, same
// fallbacks, unmasked, with runtimeConfig).
// ---------------------------------------------------------------------------

function getDefaultOrFirstLlmProvider(store: ReturnType<typeof getProviderStore>) {
  return store.getDefaultLlmProvider() ?? store.listLlmProviders()[0];
}

function getDefaultModelForProvider(
  providerType: ApiProvider['providerType'],
  options?: Record<string, unknown>,
): string {
  if (options) {
    const optModel =
      (options as Record<string, unknown>).defaultModel ||
      (options as Record<string, unknown>).model;
    if (typeof optModel === 'string' && optModel.length > 0) {
      return optModel;
    }
  }
  switch (providerType) {
    case 'ollama':
      return 'llama3.2';
    case 'openai':
    case 'openai-compatible':
    case 'openrouter':
    case 'google':
    case 'gemini-image':
      return 'gpt-4o';
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return 'claude-sonnet-4-20250514';
    default:
      return '';
  }
}

/** Exposed for the orb's model badge (automation:orb:chat-config). */
export function getActiveModelName(): string | null {
  return (getActiveProviderConfig()?.model as string) ?? null;
}

// ---------------------------------------------------------------------------
// Model selection: the orb's model picker overrides the default provider /
// model for wakeless turns only (in-memory, never writes user settings).
// ---------------------------------------------------------------------------

export interface WakeModelOption {
  providerId: string;
  label: string;
  model: string;
}

let wakeModelOverride: { providerId: string; model: string } | null = null;

/**
 * The in-flight wakeless session, if any. Set when a turn is dispatched and
 * cleared once its stream settles. Consumed by
 * `interruptActiveWakelessChat()` so collapsing the orb actually stops the
 * worker instead of orphaning a turn nobody is watching.
 */
let activeWakelessSessionId: string | null = null;

/** Exposed for tests + diagnostics. Null when no wakeless turn is running. */
export function getActiveWakelessSessionId(): string | null {
  return activeWakelessSessionId;
}

export function setWakeModelOverride(
  override: { providerId: string; model: string } | null,
): void {
  wakeModelOverride = override;
}

/** Flat (provider, model) option list for the orb's model picker. */
export function listModelOptions(): WakeModelOption[] {
  const store = getProviderStore();
  store.migrateAllLegacyProviders();
  const out: WakeModelOption[] = [];
  for (const llm of store.listLlmProviders()) {
    const opts = (llm.options ?? {}) as Record<string, unknown>;
    const models = new Set<string>();
    const def = (opts.defaultModel ?? opts.model) as string | undefined;
    if (def) models.add(def);
    if (Array.isArray(opts.enabled_models)) {
      for (const m of opts.enabled_models as string[]) {
        if (typeof m === 'string' && m) models.add(m);
      }
    }
    if (models.size === 0) {
      const fallback = getDefaultModelForProvider(llm.providerType, opts);
      if (fallback) models.add(fallback);
    }
    const label = String((llm as { name?: string }).name ?? llm.id);
    for (const model of models) {
      out.push({ providerId: llm.id, label, model });
    }
  }
  return out.slice(0, 30);
}

function getActiveProviderConfig(): Record<string, unknown> | null {
  const store = getProviderStore();
  store.migrateAllLegacyProviders();

  let llm = wakeModelOverride
    ? store.getLlmProvider(wakeModelOverride.providerId)
    : undefined;
  if (!llm) llm = getDefaultOrFirstLlmProvider(store);
  const provider = llm ? toLegacyApiProvider(llm) : undefined;
  if (!provider) return null;

  const explicit =
    wakeModelOverride?.model ||
    (provider.options?.defaultModel as string) ||
    (provider.options?.model as string) ||
    (Array.isArray(provider.options?.enabled_models) &&
      (provider.options?.enabled_models as string[])[0]) ||
    '';
  const model = explicit || getDefaultModelForProvider(provider.providerType, provider.options);
  if (!model) return null;

  let runtimeConfig: Record<string, unknown> | null = null;
  try {
    const capability = store.resolveRuntimeCapability(llm!.id, model);
    const cfg = buildRuntimeConfig(llm!, {
      modelId: model,
      capabilities: capability,
    });
    runtimeConfig = {
      providerId: cfg.providerId,
      providerName: cfg.providerName,
      apiFormat: cfg.apiFormat,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      accessToken: cfg.accessToken,
      headers: cfg.headers,
      model: cfg.model,
      modelCapabilities: cfg.modelCapabilities,
      modelCompat: cfg.modelCompat,
      requestOptions: cfg.requestOptions,
    };
  } catch (err) {
    logger.warn(
      'wakeless: runtime config derivation failed, falling back to legacy fields',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.Orb,
    );
  }

  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl || undefined,
    providerType: provider.providerType,
    model,
    provider: toLLMProvider(provider.providerType),
    authStyle: 'api_key' as const,
    runtimeConfig,
  };
}

// ---------------------------------------------------------------------------
// Context injection (focused window + screen thumbnail), both best-effort.
// ---------------------------------------------------------------------------

/** Focused-window summary for the prompt preamble; '' when unavailable. */
function buildContextPreamble(): string {
  try {
    const bridge = getOSContextBridge();
    if (!bridge.isEnabled()) return '';
    const ctx = bridge.getCurrent();
    const focused = ctx?.focusedEntity as
      | { properties?: Record<string, unknown> }
      | null
      | undefined;
    const props = focused?.properties ?? {};
    const title = typeof props.title === 'string' ? props.title.slice(0, 120) : '';
    const selected =
      typeof props.selectedText === 'string' ? props.selectedText.slice(0, 500) : '';
    const text = typeof props.text === 'string' ? props.text.slice(0, 300) : '';
    const lines: string[] = ['[用户当前屏幕上下文]'];
    if (title) lines.push(`- 焦点窗口标题：${title}`);
    if (selected) lines.push(`- 选中文本：${selected}`);
    else if (text) lines.push(`- 可见文本：${text}`);
    return lines.length > 1 ? `${lines.join('\n')}\n\n` : '';
  } catch {
    return '';
  }
}

/**
 * Pick the screen source matching the display under the cursor. Falls back
 * to `sources[0]` (primary) on a single-monitor setup, when no source
 * matches the cursor's display, or when `displayId` is null (lookup failed).
 * Returns `undefined` only when there are no sources at all (caller skips
 * the screenshot). Pure + side-effect free so it is unit-testable.
 *
 * Previously the orb always captured `sources[0]` (the primary screen), so
 * waking on a secondary display produced a screenshot of the wrong monitor
 * — breaking the "context matches what the user is looking at" contract.
 * (Audit bug ④.)
 */
export function selectScreenSource(
  sources: DesktopCapturerSource[],
  displayId: number | null,
): DesktopCapturerSource | undefined {
  if (sources.length === 0) return undefined;
  if (displayId === null) return sources[0];
  const match = sources.find((s) => s.display_id === String(displayId));
  return match ?? sources[0];
}

/** Screen thumbnail as a base64 PNG; null when capture fails. */
async function captureScreenBase64(): Promise<string | null> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: SCREENSHOT_MAX_EDGE, height: SCREENSHOT_MAX_EDGE },
    });
    // Capture the display the cursor is currently on — wake can happen on
    // any monitor, not just the primary. Best-effort: fall back to primary
    // if the cursor/display lookup throws for any reason.
    let displayId: number | null = null;
    try {
      const cursor = screen.getCursorScreenPoint();
      displayId = screen.getDisplayNearestPoint(cursor).id;
    } catch {
      displayId = null;
    }
    const chosen = selectScreenSource(sources, displayId);
    const png = chosen?.thumbnail?.toPNG();
    return png && png.length > 0 ? png.toString('base64') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chat dispatch
// ---------------------------------------------------------------------------

export interface WakelessChatFile {
  name: string;
  type: string;
  /** data: URL with base64 payload. */
  url: string;
}

/**
 * Build the JSON body for the wakeless chat POST. Centralized so the
 * working-directory wiring is testable without spinning up the agent
 * server. (Audit bug ③: wakeless previously omitted `workingDirectory` /
 * `defaultWorkspaceDirectory`, so the agent ran in the worker's default cwd
 * instead of the user's configured workspace — file/tool tasks could hit the
 * wrong directory.)
 *
 * `workingDirectory` is passed through verbatim; when it is `undefined` the
 * keys are dropped from the JSON (same contract as `agent-run.ts:153`),
 * letting the worker fall back to its default cwd.
 */
export function buildWakelessRequestBody(params: {
  prompt: string;
  providerConfig: Record<string, unknown>;
  files: Array<Record<string, string>>;
  workingDirectory?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    providerConfig: params.providerConfig,
    options: { wakeless: true, files: params.files },
  };
  // Omit both keys when unset so the in-memory object matches the wire
  // form (JSON.stringify would also drop them, but being explicit keeps
  // the contract honest and lets callers read the object directly).
  if (params.workingDirectory !== undefined) {
    body.workingDirectory = params.workingDirectory;
    body.defaultWorkspaceDirectory = params.workingDirectory;
  }
  return body;
}

/**
 * Start a wakeless chat session. Resolves once the turn is dispatched;
 * the response streams to the orb via the `automation:orb:*` IPC.
 * `files` are caller-supplied attachments (data URLs); the auto screen
 * thumbnail is appended when capture succeeds.
 */
export async function startWakelessChat(
  prompt: string,
  files: WakelessChatFile[] = [],
): Promise<WakelessChatResult> {
  const sessionId = newWakelessSessionId();
  const turnId = newWakelessTurnId();

  const port = getAgentServerPort();
  if (port === null) {
    logger.warn(
      'wakeless: agent server not running, rejecting orb submit',
      { sessionId },
      LogComponent.Orb,
    );
    return {
      accepted: false,
      note: 'Agent server is not running. Start the app and try again.',
    };
  }

  const providerConfig = getActiveProviderConfig();
  if (!providerConfig) {
    logger.warn(
      'wakeless: no provider configured, rejecting orb submit',
      { sessionId },
      LogComponent.Orb,
    );
    return {
      accepted: false,
      note: 'No model provider configured. Configure one in Settings first.',
    };
  }

  const preamble = buildContextPreamble();
  const composedPrompt = preamble ? `${preamble}${prompt}` : prompt;

  const allFiles: Array<Record<string, string>> = files.map((f, i) => ({
    id: randomUUID(),
    name: f.name || `attachment-${i + 1}`,
    type: f.type || 'application/octet-stream',
    url: f.url,
  }));
  const screenshot = await captureScreenBase64();
  if (screenshot) {
    allFiles.push({
      id: randomUUID(),
      name: 'screenshot.png',
      type: 'image/png',
      url: `data:image/png;base64,${screenshot}`,
    });
  }

  logger.info(
    'wakeless: dispatching orb chat to agent server',
    {
      sessionId,
      promptLength: composedPrompt.length,
      withContext: preamble.length > 0,
      withScreenshot: allFiles.length > 0,
    },
    LogComponent.Orb,
  );

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildWakelessRequestBody({
          prompt: composedPrompt,
          providerConfig,
          files: allFiles,
          // Audit bug ③: run the wakeless agent in the user's configured
          // workspace instead of the worker's default cwd. Empty/unset →
          // undefined → keys dropped → worker default (unchanged behaviour).
          workingDirectory: getSetting('workspaceDir') || undefined,
        }),
      ),
    });
  } catch (err) {
    logger.warn(
      'wakeless: agent server fetch failed',
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      LogComponent.Orb,
    );
    return { accepted: false, note: 'Agent server is unreachable.' };
  }

  if (!res.ok || !res.body) {
    const errorBody = await res.text().catch(() => '');
    logger.warn(
      'wakeless: agent server rejected the chat',
      { sessionId, status: res.status, errorBody: errorBody.slice(0, 200) },
      LogComponent.Orb,
    );
    return { accepted: false, note: `Agent server error ${res.status}.` };
  }

  // The turn is dispatched; stream SSE in the background and forward to
  // the orb. `submit` returns immediately so the orb can show LOADING.
  activeWakelessSessionId = sessionId;
  void consumeWakelessStream(sessionId, turnId, res);

  return { accepted: true, sessionId };
}

/**
 * Pump the SSE response and forward events to the orb renderer.
 * Mirrors the renderer's agent-sse-client event names (post-`normalizeWorkerEvent`):
 * `text`, `thinking`, `status`, `tool_use_started`, `done`, `error`, …
 */
async function consumeWakelessStream(
  sessionId: string,
  turnId: string,
  res: Response,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let finished = false;

  const finishWithResult = (text: string): void => {
    if (finished) return;
    finished = true;
    sendOrbResult({ turnId, text, finishedAt: new Date().toISOString() });
  };

  // Hard cap on the wakeless turn. Enforced here (not just on interrupt)
  // so a hung worker can never pin an orphaned session forever.
  const timeout = setTimeout(() => {
    logger.warn(
      'wakeless: hard timeout reached, interrupting',
      { sessionId, timeoutMs: WAKELESS_TIMEOUT_MS },
      LogComponent.Orb,
    );
    finishWithResult(`**超时**：任务超过 ${Math.round(WAKELESS_TIMEOUT_MS / 1000)} 秒未完成，已中断。`);
    void reader.cancel().catch(() => {});
    void interruptWakelessChat(sessionId);
  }, WAKELESS_TIMEOUT_MS);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf('\n');
      while (sep !== -1) {
        const line = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 1);
        sep = buffer.indexOf('\n');

        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let event: { type?: string; data?: unknown };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        const data = (event.data ?? {}) as Record<string, unknown>;
        switch (event.type) {
          case 'text': {
            const delta = typeof data.content === 'string' ? data.content : '';
            if (delta) {
              accumulated += delta;
              sendOrbChunk({ delta, turnId });
            }
            break;
          }
          case 'thinking':
          case 'status': {
            const label =
              typeof data.content === 'string'
                ? data.content
                : typeof data.message === 'string'
                  ? data.message
                  : null;
            if (label) {
              sendOrbProgress({ stage: 'thinking', label: label.slice(0, 60) });
            }
            break;
          }
          case 'tool_use_started': {
            const name = typeof data.name === 'string' ? data.name : 'tool';
            sendOrbProgress({ stage: 'tool', label: `用 ${name}` });
            break;
          }
          case 'error': {
            const message =
              typeof data.message === 'string' ? data.message : 'Agent 出错';
            logger.warn(
              'wakeless: agent stream error',
              { sessionId, message: message.slice(0, 200) },
              LogComponent.Orb,
            );
            finishWithResult(`**出错了**：${message}`);
            return;
          }
          case 'done': {
            finishWithResult(accumulated);
            return;
          }
          default:
            break;
        }
      }
    }
    // Stream ended without an explicit done/error frame — deliver what we have.
    logger.warn(
      'wakeless: SSE stream ended before a done frame',
      { sessionId, bytes: accumulated.length },
      LogComponent.Orb,
    );
    finishWithResult(accumulated);
  } catch (err) {
    logger.warn(
      'wakeless: SSE stream failed',
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      LogComponent.Orb,
    );
    if (!finished) {
      finishWithResult(`**连接中断**：${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    clearTimeout(timeout);
    if (activeWakelessSessionId === sessionId) {
      activeWakelessSessionId = null;
    }
    if (!finished) {
      finished = true;
      sendOrbHide();
    }
  }
}

/**
 * Send a DELETE to the agent server for a wakeless session, interrupting
 * the worker. Called on orb collapse or hard timeout.
 */
export async function interruptWakelessChat(sessionId: string): Promise<void> {
  try {
    const port = getAgentServerPort();
    if (port === null) return;
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/chat`, {
      method: 'DELETE',
    });
    logger.info('wakeless: interrupted', { sessionId }, LogComponent.Orb);
  } catch (err) {
    logger.warn(
      'wakeless: interrupt failed',
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      LogComponent.Orb,
    );
  }
}

/**
 * Interrupt the in-flight wakeless turn, if any. Best-effort: a failure
 * only costs a few tokens, so callers (orb collapse) should not await it
 * on the UI path. Safe to call when nothing is running.
 */
export async function interruptActiveWakelessChat(): Promise<void> {
  const sessionId = activeWakelessSessionId;
  if (!sessionId) return;
  activeWakelessSessionId = null;
  await interruptWakelessChat(sessionId);
}
