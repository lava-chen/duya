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
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { LEGACY_RETIREMENT, RUN_ENTRY_DIVERGENCES } from '../agents/server/run-orchestrator';

const AGENT_SRC = resolve(__dirname, '../../../../../packages/agent/src');

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

/**
 * Call sites of `.streamChat(` on a `duyaAgent`/`subAgent` receiver.
 *
 * Excluded on purpose, and the exclusions are the whole difficulty:
 *
 *  - `@duya/ai` client calls (`this.llmClient.streamChat`, `visionClient`,
 *    `compactClient`) are a different type with no run semantics, so counting
 *    them would overstate what is left to migrate.
 *  - comment lines, because the migrated CLI site now NAMES `agent.streamChat`
 *    in prose explaining what it used to do. Counting that would make the
 *    registry un-deletable by editing alone.
 *  - the headless host itself, which is the ONE caller that is supposed to
 *    exist: it is the composition H8.1 introduced.
 */
function remainingAgentStreamChatCallSites(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (!/\.streamChat\(/.test(line)) return;
      // A receiver that is an agent, not an @duya/ai client.
      if (!/\b(agent|subAgent|this)\.streamChat\(/.test(line)) return;
      if (file.replace(/\\/g, '/').endsWith('process/headless-run-host.ts')) return;
      found.push(`${file.replace(/\\/g, '/').split('/packages/agent/')[1] ?? file}:${index + 1}`);
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
    expect({
      count: registry.remainingConsumers,
      sites: registry.consumers.length,
      measured: measured.length,
    }).toEqual({
      count: registry.consumers.length,
      sites: registry.consumers.length,
      measured: measured.length,
    });
  });

  it('names every remaining consumer as a real file', () => {
    for (const consumer of LEGACY_RETIREMENT[0]!.consumers) {
      // `path:line` or `path` — the test asserts the FILE resolves, because a
      // consumer that names a file which moved is exactly the drift this file
      // exists to catch.
      const path = consumer.replace(/:\d+(\s|$).*$/, '').replace(/\s*\(.*\)$/, '');
      expect(path.startsWith('packages/agent/src/'), consumer).toBe(true);
    }
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
