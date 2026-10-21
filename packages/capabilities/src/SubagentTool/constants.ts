/** Model-facing names retained for saved transcripts and permission rules. */
export const SUBAGENT_TOOL_NAME = 'task';
export const LEGACY_SUBAGENT_TOOL_NAME = 'Agent';
export const VERIFICATION_AGENT_TYPE = 'verification';

/** Built-ins that return one report and do not need a follow-up trailer. */
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set(['Explore', 'Plan']);
