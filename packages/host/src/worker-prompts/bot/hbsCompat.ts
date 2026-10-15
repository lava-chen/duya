/**
 * bot/hbsCompat.ts — shared HbsPromptSystem sentinel + sync wrapper helpers.
 *
 * Plan 558 legacy bridge: pre-plan-558 tests called `renderBotIdentity` /
 * `renderBotCommsRules` / `renderBotTaskDelegation` synchronously and
 * asserted on the raw output. The new template pipeline renders through
 * `BotPromptAssembly`, which is async (sections can be volatile and use
 * the dual-key snapshot cache). This module lets deprecated wrappers
 * stay synchronous: the wrapper instantiates a private `HbsPromptSystem`
 * and calls `renderStaticTemplate` directly, bypassing prepare / budget /
 * cache.
 *
 * The sentinel fills the few host `PromptContext` fields that
 * `mapPromptContextToHbs` reads, so the rendered template sees the same
 * shape the production path provides (we don't want identity-only sections
 * to explode because `botName` / `agentDirectory` were absent).
 */

import { HbsPromptSystem } from '../hbs/HbsPromptSystem.js'
import { TOOL_NAMES } from '../types.js'

export const identityHbsSentinel = {
  workingDirectory: '',
  platform: process.platform,
  shell: '',
  modelId: '',
  enabledTools: new Set<string>([
    'Read', 'Skill', 'SessionSearch', 'TodoWrite', 'Task',
    TOOL_NAMES.MESSAGE_SESSION,
  ]),
  sessionStartTime: 0,
}

export function makeBotTemplateHbs(): HbsPromptSystem {
  return new HbsPromptSystem()
}