/**
 * Automation mode modifier.
 *
 * Headless mode for programmatic agents (e.g. the memory curator). It is a
 * no-op overlay: it declares no tools, no prompt, and no hooks, so the run
 * falls through to the normal agent loop unchanged. Its only job is to give
 * `mode: 'automation'` a registry entry, otherwise `DuyaAgent.streamChat`
 * rejects the mode as "Unknown mode".
 *
 * The curator supplies its own system prompt and tool allow-list via
 * `ChatStartCommand.options`, so this mode intentionally configures nothing.
 */

import type { ModeModifier } from './types.js';

export const automationMode: ModeModifier = {
  id: 'automation',
  kind: 'message',
  display: { label: 'Automation' },
};
