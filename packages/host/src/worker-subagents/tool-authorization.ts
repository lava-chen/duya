/**
 * The tool set a sub-agent may actually USE.
 *
 * ## Why this resolves NAMES and not a `Tool[]`
 *
 * The engine advertises the child's tools from the registry the turn carries
 * and dispatches through that same registry. A restriction that only reached a
 * `Tool[]` the engine ignored was a comment: the model was still shown the
 * denied tool, and the denied tool still ran. The caller narrows the REGISTRY
 * to the names this module returns — that is what makes the restriction
 * binding.
 *
 * ## The rules, in the order they bite
 *
 *  1. The agent DEFINITION's `tools` list bounds the set. `['*']` (or absent)
 *     names no bound of its own; anything else names the tools.
 *  2. The per-call OVERLAY's `allow` narrows further, and its `deny` removes.
 *     `deny` wins over `allow`: a model that lists a tool in both still
 *     loses it — the conservative reading of an ambiguous instruction.
 *  3. The orchestration tools are withheld from every child, AFTER the
 *     overlay, so `tools: { allow: ['task'] }` can never re-grant a sub-agent
 *     the ability to spawn siblings.
 *
 * The definition's `disallowedTools` is already applied upstream: the
 * `definitionToolNames` this module receives came out of `resolveAgentTools`,
 * which filters them out.
 *
 * ## Names are matched CASE-INSENSITIVELY
 *
 * The registry mixes cases — `read` and `grep` next to `EnterPlanMode` and
 * `Skill` — and the names a model writes are the CamelCase ones. A
 * case-sensitive comparison matched nothing at all, which under the old
 * allow-all fallback read as "allow everything".
 *
 * ## An empty result means ZERO tools
 *
 * There is no allow-all fallback anywhere in this path. An `allow` list that
 * names no real tool says "allow nothing", and reading it as "allow
 * everything" is the exact inversion this replaces.
 */

import type { SubagentToolOverlay } from '@duya/capabilities/SubagentTool'

export type SubagentToolAuthorization = {
  /**
   * Canonical registry names the child may use, in registry order. Canonical
   * means the registry's own spelling — the casing the engine will compare
   * against, not the casing the caller wrote.
   */
  readonly allowed: readonly string[]
  /**
   * Names the overlay asked for that did not make it into {@link allowed} —
   * either because no such tool exists, or because the definition's own
   * bound excluded it. Reported so the caller can warn the model instead of
   * silently ignoring the request.
   */
  readonly dropped: readonly string[]
}

/**
 * Resolve the effective tool set for one sub-agent run.
 *
 * @param registryToolNames Every tool the child's registry holds, including
 *   the MCP tools inherited from the parent. The REGISTRY is the authority:
 *   it is what the engine advertises from and dispatches through.
 * @param definitionToolNames The tools the agent definition resolved to,
 *   already intersected with the parent's visible tools and stripped of
 *   `disallowedTools`.
 * @param definitionIsWildcard True when the definition used the wildcard
 *   (`tools: ['*']` or no `tools` at all) and therefore named no bound.
 */
export function authorizeSubagentTools(input: {
  readonly registryToolNames: readonly string[]
  readonly definitionToolNames: readonly string[]
  readonly definitionIsWildcard: boolean
  readonly overlay?: SubagentToolOverlay | undefined
  readonly forbiddenTools: ReadonlySet<string>
}): SubagentToolAuthorization {
  const { registryToolNames, definitionToolNames, definitionIsWildcard, overlay, forbiddenTools } = input

  // Canonical registry name per lowercased name. The FIRST registration wins,
  // so the result keeps the registry's own order.
  const canonical = new Map<string, string>()
  for (const name of registryToolNames) {
    const key = name.toLowerCase()
    if (!canonical.has(key)) canonical.set(key, name)
  }

  // The definition's own bound, expressed against the registry.
  //
  // The wildcard branch is the only place the registry answers on its own,
  // and it is a fallback for an EMPTY input rather than a way to widen a
  // restriction: a wildcard definition whose resolved list came back EMPTY
  // has nothing to narrow by (the parent's visible list was empty), so the
  // registry is the whole set. A definition that named tools and resolved to
  // none of them gets an empty bound — "named nothing real" means "no tools",
  // never "all tools".
  const bound = new Set<string>()
  if (definitionIsWildcard && definitionToolNames.length === 0) {
    for (const name of registryToolNames) bound.add(name.toLowerCase())
  }
  else {
    for (const name of definitionToolNames) {
      const key = name.toLowerCase()
      if (canonical.has(key)) bound.add(key)
    }
  }

  if (overlay?.allow?.length) {
    const allow = new Set<string>()
    for (const name of overlay.allow) {
      const key = name.toLowerCase()
      if (canonical.has(key)) allow.add(key)
    }
    // The overlay narrows the definition's bound; it does not replace it.
    // The definition is the user's own configuration and the overlay is a
    // per-call request, so the narrower of the two wins.
    for (const key of [...bound]) {
      if (!allow.has(key)) bound.delete(key)
    }
  }

  for (const name of overlay?.deny ?? []) bound.delete(name.toLowerCase())
  for (const name of forbiddenTools) bound.delete(name.toLowerCase())

  const allowed = registryToolNames.filter((name) => bound.has(name.toLowerCase()))

  const dropped = (overlay?.allow ?? []).filter(
    (name) => !allowed.some((kept) => kept.toLowerCase() === name.toLowerCase()),
  )

  return { allowed, dropped }
}
