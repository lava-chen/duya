/**
 * @duya/browser — browser engine package (plan 583, seam A).
 *
 * Everything the agent needs to drive a real browser lives here: the CDP
 * clients (extension / webview / human-like / Playwright), the backend
 * degradation chain, the action registry and its schema generator, the
 * snapshot engine, domain blocking, result formatting, self-healing, and
 * the platform extractor/hook registries.
 *
 * What deliberately does NOT live here:
 *   - the `BaseTool` adapter (`packages/agent/src/tool/BrowserTool/`),
 *     which is the agent-tool contract rather than browser capability;
 *   - the built-in browser window (`electron/services/browser/`), which is
 *     product surface owned by plan 573.
 *
 * Host wiring: call `setBrowserLogger()` once so engine logs flow into the
 * host's structured logger. Everything else is usable as-is.
 */

// --- Host injection -------------------------------------------------------
export { setBrowserLogger, getBrowserLogger, logger, BROWSER_LOG_COMPONENT } from './logger.js';
export type { BrowserLogger, LogContext } from './logger.js';

// --- CDP clients ----------------------------------------------------------
export {
  ExtensionCDPClient,
  PlaywrightCDPClient,
  createCDPClient,
  createCDPClientForMode,
  clearBrowserCache,
  fetchBlockedDomains,
} from './CDPClient.js';
export type { ICDPClient, CDPMode, CDPResponse, TabInfo, BrowserCookie } from './CDPClient.js';
export {
  WebviewCDPClient,
  DebuggerConflict,
  WebviewNotReady,
} from './WebviewCDPClient.js';
export type { WebviewCDPClientOptions } from './WebviewCDPClient.js';
export { HumanLikeCDPClient } from './HumanLikeCDPClient.js';

// --- Backend resolution ---------------------------------------------------
export { resolveBackend, DEFAULT_BROWSER_CONFIG } from './backend-resolver.js';
export type { ResolvedBackend, BrowserToolConfig } from './backend-resolver.js';

// --- Core engine pieces ---------------------------------------------------
export { FallbackBrowser, fallbackBrowser } from './FallbackBrowser.js';
export type { FallbackSnapshot } from './FallbackBrowser.js';
export { ParallelFetcher, parallelFetcher } from './ParallelFetcher.js';
export type { FetchTask, FetchResult } from './ParallelFetcher.js';
export { BrowserPool } from './BrowserPool.js';
export type { InvestigationTask, InvestigationResult } from './BrowserPool.js';
export { SnapshotEngine, generateSnapshotJsPrompt, scrollToRefJs, getFormStateJs } from './SnapshotEngine.js';
export type { SnapshotOptions, SnapshotResult, InteractiveElement } from './SnapshotEngine.js';

// --- Actions --------------------------------------------------------------
export {
  ActionRegistry,
  SchemaGenerator,
  getAllActions,
} from './actions/index.js';
export type { ActionContext, ActionHandler } from './actions/types.js';

// --- Platform hooks + extractors -----------------------------------------
export { PlatformHookManager } from './platform-hooks/PlatformHookManager.js';

// --- Policy / safety ------------------------------------------------------
export {
  isUrlBlocked,
  getEffectiveBlockedDomains,
  normalizeDomain,
  isValidDomain,
  DEFAULT_BLOCKED_DOMAINS,
} from './DomainBlocker.js';
export type { DomainBlockerConfig } from './DomainBlocker.js';
export {
  resolvePublicIP,
  isSafeUrl,
  isSafeUrlSync,
  isCDNImageUrl,
  validateRedirectUrl,
} from './urlSafety.js';
export type { URLSafetyResult } from './urlSafety.js';

// --- Presentation / diagnostics ------------------------------------------
export { formatResult } from './ResultFormatter.js';
export {
  isRecoverableSessionInvalidation,
  retryOnceAfterSessionInvalidation,
  SESSION_SELF_HEAL_FAILED_MSG,
} from './selfHealing.js';
export { detectNetworkEnvironment, resetNetworkEnvironmentCache, setNetworkEnvironmentForTest } from './networkEnv.js';
export { getPrompt, DESCRIPTION } from './prompt.js';

// --- Tool-facing constants ------------------------------------------------
export {
  BROWSER_TOOL_NAME,
  BROWSER_TOOL_DESCRIPTION,
  BROWSER_TOOL_DESCRIPTION_HUMAN_LIKE,
  DEFAULT_TIMEOUT,
  MAX_CONTENT_LENGTH,
  SNAPSHOT_MAX_LENGTH,
} from './constants.js';

// --- Shared types ---------------------------------------------------------
export type { BrowserBackendMode, BrowserMode, NetworkEnvironment } from './types.js';
