/**
 * The retirement registry, checked against the code.
 *
 * Plan 587 H8.1's rule is that a legacy export may be deleted only when its
 * consumers reach zero, packaging and host smoke pass, and the compatibility
 * window is evidenced. Two of those three are not checkable by a unit test —
 * a packaged Electron host cannot be built here — so what this file does is
 * narrower and honest: it re-derives the CONSUMER COUNT from the source and
 * fails if the registry's number disagrees, and it asserts that the registry
 * does not claim removability while any removal condition is unmet.
 *
 * The point is that `removable: false` has to be a fact about the code rather
 * than a flag somebody set once and forgot. A registry that said `true` here
 * would be a claim that host smoke passed, and this file refuses to let it say
 * that without every condition being met.
 *
 * The first version of the count assertion compared `measured.length` with
 * `measured.length`, so it passed whatever the number was: the registry sat at
 * `7` while the tree held `2` facade call sites — `3` by the receiver-name rule
 * this file used, which counted a bound `AIClient` method as a caller of the
 * facade. It now compares the DECLARED number to the MEASURED one, checks the
 * list that backs the number, and checks it in both directions — a measured
 * site no entry names is as much a failure as a named entry that no longer
 * exists. Non-vacuity is demonstrated by perturbation, not asserted: setting the
 * declared count to a wrong number turns this file red.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { LEGACY_RETIREMENT, RUN_ENTRY_DIVERGENCES } from '../agents/server/run-orchestrator';

const ROOT = resolve(__dirname, '../../../../..');
const AGENT_SRC = resolve(ROOT, 'packages/agent/src');

/** Every `.ts` under `packages/agent/src`, recursively. */
function sourceFiles(dir: string = AGENT_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** One remaining call of the agent facade's `streamChat`. */
interface FacadeCallSite {
  /** Repo-relative path, so a failure names the file rather than a temp dir. */
  readonly path: string;
  readonly line: number;
  readonly receiver: string;
}

function describeSites(sites: readonly FacadeCallSite[]): string {
  return sites.length === 0
    ? '(none)'
    : sites.map((site) => `${site.path}:${site.line} (${site.receiver})`).join(', ');
}

/**
 * Call sites of `.streamChat(` that reach the `DuyaAgent` facade.
 *
 * Excluded on purpose, and the exclusions are the whole difficulty:
 *
 *  - `@duya/ai` client calls (`llmClient.streamChat`, `this.visionClient`,
 *    `deps.llmClient`, `client`) are a different type with no run semantics, so
 *    counting them would overstate what is left to migrate.
 *  - `Stage1Extractor.streamChat` is the sharp case: `this.streamChat` looks
 *    exactly like a facade call, but the class holds
 *    `private readonly streamChat: AIClient['streamChat']` and assigns it
 *    `llmClient.streamChat.bind(llmClient)`. It is an `@duya/ai` call wearing
 *    the facade's name, and a receiver-name census cannot tell the difference —
 *    so the exclusion is made on positive evidence (the file binds an AIClient
 *    method under that name) rather than by dropping `this` from the pattern,
 *    which would have gone blind to a real `this.streamChat` in a future
 *    DuyaAgent subclass. The limitation is deliberate and local: the evidence is
 *    per file, so a file that both binds a client method and calls the facade
 *    through `this` would hide the latter. No such file exists today, and the
 *    assertion below names the exclusion so it cannot be quietly forgotten.
 *  - comment lines, because the migrated CLI site now NAMES `agent.streamChat`
 *    in prose explaining what it used to do. Counting that would make the
 *    registry un-deletable by editing alone.
 *  - the headless host itself, which is the ONE caller that is supposed to
 *    exist: it is the composition H8.1 introduced, and it is named in the
 *    registry rather than counted as a legacy consumer.
 */
function remainingAgentStreamChatCallSites(): FacadeCallSite[] {
  const found: FacadeCallSite[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const rel = file.replace(/\\/g, '/');
    const relative = rel.split('/packages/agent/')[1] ? `packages/agent/${rel.split('/packages/agent/')[1]}` : rel;
    const bindsLlmStreamChat = text.includes("AIClient['streamChat']");
    text.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const match = /\b([A-Za-z0-9_$]+)\.streamChat\(/.exec(line);
      if (!match) return;
      const receiver = match[1]!;
      // A receiver that is an agent, not an @duya/ai client.
      const isFacadeReceiver =
        receiver === 'agent' ||
        receiver === 'subAgent' ||
        (receiver === 'this' && !bindsLlmStreamChat);
      if (!isFacadeReceiver) return;
      if (relative === 'packages/agent/src/process/headless-run-host.ts') return;
      found.push({ path: relative, line: index + 1, receiver });
    });
  }
  return found;
}

describe('H8.1 — the retirement registry matches the code', () => {
  it('re-derives the consumer count from the source', () => {
    const measured = remainingAgentStreamChatCallSites();
    const registry = LEGACY_RETIREMENT[0]!;

    // If these ever disagree, one of them is wrong. The registry is the number a
    // reader trusts, so it is the one that has to move — and a test that fails
    // here is the mechanism that stops it going stale.
    //
    // This assertion used to compare `measured.length` with `measured.length`,
    // so it passed whatever the number was: the registry sat at 7 while the
    // tree held 2 facade call sites. It now compares the DECLARED number to the
    // MEASURED one, and the message names both sides so a reader does not have
    // to re-run anything to learn which one is wrong.
    expect(
      registry.remainingConsumers,
      `LEGACY_RETIREMENT.remainingConsumers is ${registry.remainingConsumers}, but the tree has ` +
        `${measured.length} remaining facade call site(s): ${describeSites(measured)}`,
    ).toBe(measured.length);

    // The count and the list that backs it are the same claim, so they are
    // compared against each other as well.
    expect(
      registry.consumers.length,
      `LEGACY_RETIREMENT lists ${registry.consumers.length} consumer(s) but declares ` +
        `${registry.remainingConsumers}`,
    ).toBe(registry.remainingConsumers);
  });

  it('names every remaining consumer, and names nothing else', () => {
    const registry = LEGACY_RETIREMENT[0]!;
    const measured = remainingAgentStreamChatCallSites();

    // `path:line` or `path`, optionally annotated. The test asserts the FILE
    // resolves, because a consumer that names a file which moved is exactly the
    // drift this file exists to catch.
    for (const consumer of registry.consumers) {
      const path = consumer.replace(/:\d+(\s|$).*$/, '').replace(/\s*\(.*\)$/, '');
      expect(path.startsWith('packages/agent/src/'), consumer).toBe(true);
      expect(
        existsSync(resolve(ROOT, path)),
        `LEGACY_RETIREMENT names ${path}, which does not exist`,
      ).toBe(true);
    }

    // And the other direction, which is the one that made this list an audit
    // trail rather than decoration: a measured site that no entry names is a
    // consumer nobody can check.
    for (const site of measured) {
      expect(
        registry.consumers.some((consumer) => consumer.startsWith(site.path)),
        `${site.path}:${site.line} (${site.receiver}) is a remaining facade call site but no ` +
          `entry in LEGACY_RETIREMENT.consumers names it`,
      ).toBe(true);
    }
  });

  it('excludes an @duya/ai call that wears the facade name, and shows why', () => {
    // The exclusion above is a claim about a real file, so it is asserted
    // against that file rather than left in a comment where it can rot.
    const extractor = readFileSync(join(AGENT_SRC, 'memory-rollout', 'extractor.ts'), 'utf8');
    expect(extractor).toContain("AIClient['streamChat']");
    expect(extractor).toMatch(/this\.streamChat\s*=\s*llmClient\.streamChat\.bind\(/);
    expect(extractor).toContain('this.streamChat([userMessage]');

    // So it is genuinely not in the measured set.
    expect(
      remainingAgentStreamChatCallSites().map((site) => site.path),
    ).not.toContain('packages/agent/src/memory-rollout/extractor.ts');
  });

  it('does not claim removability while a removal condition is unmet', () => {
    const entry = LEGACY_RETIREMENT[0]!;

    // The load-bearing assertion. `removable` is allowed to be `false` for as
    // long as the code says so; what is forbidden is `true` while a condition
    // is unmet, because that is the claim H8.1 is not allowed to make.
    expect(entry.removable).toBe(false);
    expect(entry.removalConditions.length).toBeGreaterThan(0);
    expect(entry.blockedOn).toContain('Host smoke');

    // And the two conditions that ARE checkable are actually unmet, stated
    // rather than assumed: consumers are non-zero.
    expect(entry.remainingConsumers).toBeGreaterThan(0);
  });

  it('keeps the shim while the CLI has no direct streamChat call left', () => {
    // The part H8.1 DID retire: the CLI must have zero direct call sites, and
    // the registry must not claim otherwise. This is what "the CLI is a thin
    // shim over one host adapter" means, mechanically.
    const cli = readFileSync(join(AGENT_SRC, 'cli', 'index.ts'), 'utf8');
    const liveCallSites = cli
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
        return /\.streamChat\(/.test(line);
      });
    expect(liveCallSites).toEqual([]);
  });
});

describe('H8.1 — the census records the headless path as wired, with its limits', () => {
  it('still records that packages/cli is not a run consumer', () => {
    // The plan's claim is STILL wrong about packages/cli, and H8.1 did not make
    // it right. A reader who found only the "wired" half would conclude the
    // claim is now satisfied, which is why the divergence text names both.
    expect(RUN_ENTRY_DIVERGENCES).toHaveLength(1);
    expect(RUN_ENTRY_DIVERGENCES[0]?.claim).toContain('packages/cli');
    expect(RUN_ENTRY_DIVERGENCES[0]?.reality).toContain('never did');
  });

  it('names the host that replaced the direct DuyaAgent construction', () => {
    const reality = RUN_ENTRY_DIVERGENCES[0]?.reality ?? '';
    expect(reality).toContain('HeadlessRunHost');
    // And it states the thing that did NOT change, so the entry cannot be read
    // as "the CLI now goes through chat:start".
    expect(reality).toContain('does not pass through');
  });
});
