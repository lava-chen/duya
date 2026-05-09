/**
 * BrowserTool exports
 */

export { BrowserTool, browserTool } from './BrowserTool.js';
export { createCDPClient, ExtensionCDPClient, PlaywrightCDPClient, fetchBlockedDomains } from './CDPClient.js';
export type { ICDPClient } from './CDPClient.js';
export { BrowserPool } from './BrowserPool.js';
export type { InvestigationTask, InvestigationResult } from './BrowserPool.js';
export { SnapshotEngine } from './SnapshotEngine.js';
export { BROWSER_TOOL_NAME, BROWSER_TOOL_DESCRIPTION } from './constants.js';
export type { BrowserInput } from './BrowserTool.js';
export type { SnapshotResult, SnapshotOptions, InteractiveElement } from './SnapshotEngine.js';
export { isUrlBlocked, getEffectiveBlockedDomains, normalizeDomain, isValidDomain } from './DomainBlocker.js';
export type { DomainBlockerConfig } from './DomainBlocker.js';
