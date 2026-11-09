/**
 * The tool authorization resolver, on its own.
 *
 * These cases are the RULES; `tool-overlay-enforcement.test.ts` is the
 * behaviour that follows from them at the execution layer. Splitting them
 * this way keeps the rules readable without a worker, and keeps the
 * execution-layer test about the one thing only it can show.
 *
 * The registry's real names mix cases (`read`, `grep`, `EnterPlanMode`,
 * `Skill`), which is why every case below is written with a name that does
 * NOT match the registry's spelling unless it is meant to.
 */

import { describe, expect, it } from 'vitest';
import { authorizeSubagentTools } from '../../src/worker-subagents/tool-authorization.js';

const REGISTRY = ['read', 'grep', 'glob', 'bash', 'edit', 'EnterPlanMode', 'Skill'];

const FORBIDDEN = new Set(['task', 'message_session']);

function authorize(input: {
  registryToolNames?: readonly string[];
  definitionToolNames?: readonly string[];
  definitionIsWildcard?: boolean;
  overlay?: { allow?: string[]; deny?: string[] };
  forbiddenTools?: ReadonlySet<string>;
}) {
  return authorizeSubagentTools({
    registryToolNames: input.registryToolNames ?? REGISTRY,
    definitionToolNames: input.definitionToolNames ?? [],
    definitionIsWildcard: input.definitionIsWildcard ?? true,
    ...(input.overlay === undefined ? {} : { overlay: input.overlay }),
    forbiddenTools: input.forbiddenTools ?? FORBIDDEN,
  });
}

describe('the definition bounds the set', () => {
  it('names every tool when the definition used the wildcard', () => {
    const result = authorize({
      definitionToolNames: REGISTRY,
      definitionIsWildcard: true,
    });

    expect(result.allowed).toEqual(REGISTRY);
  });

  it('keeps only the tools the definition named', () => {
    const result = authorize({
      definitionToolNames: ['read', 'grep'],
      definitionIsWildcard: false,
    });

    expect(result.allowed).toEqual(['read', 'grep']);
  });

  it('returns nothing when the definition named tools and none of them exist', () => {
    // The old fallback read "resolved to nothing" as "allow everything",
    // which is the inversion this resolver exists to remove.
    const result = authorize({
      definitionToolNames: [],
      definitionIsWildcard: false,
    });

    expect(result.allowed).toEqual([]);
  });

  it('falls back to the whole registry when a wildcard resolved to nothing', () => {
    // The one case where the registry answers on its own: a wildcard
    // definition whose resolved list came back empty has nothing to narrow
    // by. It is a fallback for an EMPTY input, not a way to widen a bound.
    const result = authorize({
      definitionToolNames: [],
      definitionIsWildcard: true,
    });

    expect(result.allowed).toEqual(REGISTRY);
  });

  it('drops a definition tool the registry does not hold', () => {
    const result = authorize({
      definitionToolNames: ['read', 'no_such_tool'],
      definitionIsWildcard: false,
    });

    expect(result.allowed).toEqual(['read']);
  });
});

describe('the overlay narrows the bound', () => {
  it('keeps only the allowed tools', () => {
    const result = authorize({
      definitionToolNames: REGISTRY,
      overlay: { allow: ['read'] },
    });

    expect(result.allowed).toEqual(['read']);
  });

  it('removes the denied tools', () => {
    const result = authorize({
      definitionToolNames: REGISTRY,
      overlay: { deny: ['read'] },
    });

    expect(result.allowed).toEqual(['grep', 'glob', 'bash', 'edit', 'EnterPlanMode', 'Skill']);
  });

  it('lets deny win over allow', () => {
    // The conservative reading of an ambiguous instruction.
    const result = authorize({
      definitionToolNames: REGISTRY,
      overlay: { allow: ['read', 'grep'], deny: ['read'] },
    });

    expect(result.allowed).toEqual(['grep']);
  });

  it('matches the names case-insensitively', () => {
    // `Read` is the name a model writes; the registry says `read`.
    const result = authorize({
      definitionToolNames: REGISTRY,
      overlay: { allow: ['Read'] },
    });

    expect(result.allowed).toEqual(['read']);
  });

  it('returns nothing when the allow list names no tool that exists', () => {
    // "Allow nothing" is a statement, and it is honoured as one.
    const result = authorize({
      definitionToolNames: REGISTRY,
      overlay: { allow: ['no_such_tool_anywhere'] },
    });

    expect(result.allowed).toEqual([]);
  });

  it('reports the names that did not make it', () => {
    const result = authorize({
      definitionToolNames: REGISTRY,
      overlay: { allow: ['read', 'no_such_tool_anywhere'] },
    });

    expect(result.dropped).toEqual(['no_such_tool_anywhere']);
  });

  it('does not widen past the definition', () => {
    // The definition is the user's own configuration; the overlay is a
    // per-call request. The narrower of the two wins.
    const result = authorize({
      definitionToolNames: ['read'],
      definitionIsWildcard: false,
      overlay: { allow: ['read', 'bash'] },
    });

    expect(result.allowed).toEqual(['read']);
  });
});

describe('the orchestration tools are withheld from every child', () => {
  it('removes them after the overlay, so an allow list cannot re-grant them', () => {
    const result = authorize({
      registryToolNames: ['read', 'task', 'message_session'],
      definitionToolNames: ['read', 'task', 'message_session'],
      overlay: { allow: ['read', 'task', 'message_session'] },
    });

    expect(result.allowed).toEqual(['read']);
  });
});
