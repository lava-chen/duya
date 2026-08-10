/**
 * Agent-package feature flags (Plan 408).
 *
 * `duya_slim_subagent_agentsmd` — when enabled (default), built-in read-only
 * sub-agents (Explore / Plan / CodeReview / Research) skip both the AGENTS.md
 * refresh walk in preBuildHook and the first-turn AGENTS.md user-message
 * injection, saving 5-50K input tokens per sub-agent turn. Aligns with
 * claude-code-haha's omitClaudeMd behavior. Override via the
 * `DUYA_SLIM_SUBAGENT_AGENTSMd` env var (`false`/`0` to disable) for a global
 * rollback without a code change.
 */

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export const DUYA_SLIM_SUBAGENT_AGENTSMd: boolean = envFlag(
  'DUYA_SLIM_SUBAGENT_AGENTSMd',
  true,
);

export function isSubagentSlimAgentsMdEnabled(): boolean {
  return DUYA_SLIM_SUBAGENT_AGENTSMd;
}
