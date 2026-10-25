/**
 * bot-boundary-gate.test.ts — the directions the Bot boundary gate must
 * already have teeth for, on a tree where the `@duya/bot` package does not
 * exist yet.
 *
 * ## The S0 shape of the proof
 *
 * The personal-agent framework plan (S0, "boundary and behavior baseline")
 * accepts this slice on mutation evidence: the reverse edges Bot→Host,
 * core/runtime→Bot and UI→Host must be shown to go RED, and the live tree
 * must be GREEN with the bot rule honestly `pending`. So every rule below
 * carries both halves:
 *
 *   - live assertions, which name the state of THIS tree (0 findings, real
 *     denominators, `unreadable === 0`), and
 *   - fixture mutations, which attach a forbidden edge to a scanned root and
 *     demand the rule name the edge, the owner, and the chain — then go GREEN
 *     again when the same reference is demoted to `import type`, because a
 *     type-only reference is erased by tsc and is not a runtime coupling.
 *
 * The demotion case is not decoration: it is exactly the mutation a
 * developer applies to "fix" the gate instead of the code, and the G11-1 test
 * this file is modeled on records why it has to stay legal.
 *
 * ## Fixture placement
 *
 * The R1/R2 fixtures live INSIDE the trees the rules scan
 * (`packages/bot/src/`, `packages/agent-core/src/`), because a fixture parked
 * outside every scanned root produces zero findings regardless of what it
 * contains — `browser-closure-gate.test.ts` records the failure mode. No
 * manifest is written for the fake bot package: the rules resolve the
 * forbidden edges through RELATIVE imports crossing the package directory,
 * which is precisely the edge shape the rules forbid. Every fixture is
 * removed in a `finally`.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from './import-graph.mjs';
import {
  BOT_SURFACE_GROUPS,
  CLIENT_AXIS_MIN_SCANNED,
  botCensus,
  botClosureRule,
  botSourceFiles,
  clientAxisRule,
  collectBotBoundaryReport,
  isBotBoundaryClean,
  reverseIntoBotRule,
} from './bot-boundary-gate.mjs';
import type { BotBoundaryReport } from './bot-boundary-gate.ts';

const BOT_FIXTURE = 'packages/bot/src/__bot_boundary_fixture__';
const CLIENT_FIXTURE = 'packages/ui/src/__bot_boundary_fixture__';
const CORE_FIXTURE = 'packages/agent-core/src/__bot_boundary_fixture__.ts';

/**
 * Resolve a fixture path, refusing anything that leaves the checkout.
 *
 * Every fixture path in this file is a repo-relative constant, but the
 * resolver itself does not trust that: a traversal out of `ROOT` is a
 * precondition failure, not a write.
 */
function safeResolve(relPath: string): string {
  const target = path.resolve(ROOT, relPath);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    throw new Error(`fixture path escapes the checkout root: ${relPath}`);
  }
  return target;
}

function writeFixture(relFile: string, body: string): void {
  const target = safeResolve(relFile);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
}

function dropFixture(relPath: string): void {
  rmSync(safeResolve(relPath), { recursive: true, force: true });
}

describe('live tree: the S0 state is measured-clean with bot honestly pending', () => {
  const report = collectBotBoundaryReport();

  it('R1 is pending while the package is absent, measured-clean once it exists', () => {
    const r1 = report.botClosure;
    // Conditional, not hardcoded: the day S2 adds `packages/bot`, this
    // assertion must keep holding without an edit — the gate flips to
    // measured and the boundary starts being enforced in production.
    if (!r1.present) {
      expect(r1.status).toBe('pending');
      expect(r1.findings).toEqual([]);
    } else {
      expect(r1.status).toBe('measured');
      expect(r1.walked).toBeGreaterThanOrEqual(r1.seeds);
      expect(r1.findings).toEqual([]);
    }
    expect(r1.unreadable).toBe(0);
  });

  it('R2 measured real downward packages, no reverse edge into bot', () => {
    const r2 = report.reverseIntoBot;
    expect(r2.blind).toBe(false);
    expect(r2.scanned).toBeGreaterThanOrEqual(100);
    // A green carried on unreadable files is the blind green the floors
    // exist to prevent; the live tree has no excuse for any.
    expect(r2.unreadable).toBe(0);
    expect(r2.findings).toEqual([]);
  });

  it('R3 measured the client surfaces, no edge into host or desktop', () => {
    const r3 = report.clientAxis;
    expect(r3.blind).toBe(false);
    expect(r3.scanned).toBeGreaterThanOrEqual(CLIENT_AXIS_MIN_SCANNED);
    expect(r3.unreadable).toBe(0);
    expect(r3.findings).toEqual([]);
  });

  it('the whole gate is clean', () => {
    expect(isBotBoundaryClean(report as BotBoundaryReport)).toBe(true);
    expect(report.clean).toBe(true);
  }, 300_000);
});

describe('R1 goes RED when a bot source file imports outside its allowlist', () => {
  it('names the edge and the owner, and scans subpaths, not just a barrel', () => {
    // `entry.ts` re-exports `local.ts`, but the finding must land on
    // `local.ts` — the file that makes the forbidden import — because every
    // bot source file is a seed. A gate that only read a barrel entry would
    // pass this fixture, and "one convenient import, one directory deeper"
    // is the real regression shape. The forbidden edges use both resolution
    // forms: a RELATIVE cross-package specifier (no manifest exists for the
    // fake bot package, which is fine — the edge shape is what is under
    // test) and a bare `@duya/data` specifier resolved through the manifest.
    writeFixture(`${BOT_FIXTURE}/entry.ts`, "export { local } from './local.js';\n");
    writeFixture(
      `${BOT_FIXTURE}/local.ts`,
      [
        "import { hostThing } from '../../../host/src/index.js';",
        "import { dataThing } from '@duya/data';",
        'export const local = hostThing ?? dataThing;',
        '',
      ].join('\n'),
    );
    try {
      expect(botSourceFiles().length).toBeGreaterThanOrEqual(2);
      const r1 = botClosureRule();
      expect(r1.status).toBe('measured');
      expect(r1.walked).toBeGreaterThanOrEqual(2);

      const owners = r1.findings.map((f) => f.owner);
      expect(owners).toContain('@duya/host');
      expect(owners).toContain('@duya/data');

      const hostFinding = r1.findings.find((f) => f.owner === '@duya/host')!;
      expect(hostFinding.from).toBe(`${BOT_FIXTURE}/local.ts`);
      expect(hostFinding.spec).toBe('../../../host/src/index.js');
      expect(hostFinding.to).toBe('packages/host/src/index.ts');
    } finally {
      dropFixture('packages/bot');
    }
  }, 120_000);

  it('is GREEN on the same fixture once every edge is demoted to `import type`', () => {
    writeFixture(`${BOT_FIXTURE}/entry.ts`, "import type { HostThing } from '@duya/host';\nexport const kind = 'type-only';\n");
    try {
      const r1 = botClosureRule();
      expect(r1.status).toBe('measured');
      expect(r1.findings).toEqual([]);
      // The type-only reference is counted, not thrown away: the treatment
      // is visible instead of silent.
      expect(r1.typeOnlyRefs.map((r) => r.owner)).toContain('@duya/host');
    } finally {
      dropFixture('packages/bot');
    }
  }, 120_000);
});

describe('R2 goes RED when a downward package imports bot', () => {
  it('reports the agent-core edge that teaches core that bot exists', () => {
    // The fake bot leaf must EXIST for the edge to resolve; the fixture in
    // agent-core is the violation, the leaf is only the target.
    writeFixture('packages/bot/src/leaf.ts', 'export const leaf = 1;\n');
    writeFixture(
      CORE_FIXTURE,
      "import { leaf } from '../../bot/src/leaf.js';\nexport const coreLeak = leaf;\n",
    );
    try {
      const r2 = reverseIntoBotRule();
      expect(r2.blind).toBe(false);
      expect(r2.findings).toEqual([
        {
          from: 'packages/agent-core/src/__bot_boundary_fixture__.ts',
          spec: '../../bot/src/leaf.js',
          to: 'packages/bot/src/leaf.ts',
        },
      ]);
    } finally {
      dropFixture(CORE_FIXTURE);
      dropFixture('packages/bot');
    }
  }, 120_000);

  it('is GREEN again once the edge is gone (target file removed with it)', () => {
    const r2 = reverseIntoBotRule();
    expect(r2.blind).toBe(false);
    expect(r2.findings).toEqual([]);
  }, 120_000);
});

describe('R3 goes RED when a client surface reaches the composition layer', () => {
  it('reports the ui edge into @duya/host, and the desktop direction too', () => {
    writeFixture(
      `${CLIENT_FIXTURE}/into-host.ts`,
      "import { hostThing } from '@duya/host';\nexport const leak = hostThing;\n",
    );
    writeFixture(
      `${CLIENT_FIXTURE}/into-desktop.ts`,
      "import { mainThing } from '../../desktop/src/main/ipc/bot-handlers.js';\nexport const leak2 = mainThing;\n",
    );
    try {
      const r3 = clientAxisRule();
      expect(r3.blind).toBe(false);
      const specs = r3.findings.map((f) => f.spec);
      expect(specs).toContain('@duya/host');
      const hostFinding = r3.findings.find((f) => f.spec === '@duya/host')!;
      expect(hostFinding.from).toBe(`${CLIENT_FIXTURE}/into-host.ts`);
      expect(hostFinding.target).toBe('packages/host/');
    } finally {
      dropFixture(CLIENT_FIXTURE);
    }
  }, 120_000);

  it('is GREEN when the same reference is a type-only import, and counts it', () => {
    writeFixture(
      `${CLIENT_FIXTURE}/type-only.ts`,
      "import type { HostThing } from '@duya/host';\nexport type ref = HostThing;\n",
    );
    try {
      const r3 = clientAxisRule();
      expect(r3.findings).toEqual([]);
      expect(r3.typeOnlyRefs.map((r) => r.spec)).toContain('@duya/host');
    } finally {
      dropFixture(CLIENT_FIXTURE);
    }
  }, 120_000);
});

describe('the blind state cannot read as clean', () => {
  it('isBotBoundaryClean rejects a blind or finding-bearing rule set', () => {
    const measured = {
      present: true,
      status: 'measured',
      seeds: 2,
      walked: 4,
      unreadable: 0,
      findings: [],
      typeOnlyRefs: [],
      summary: 'measured',
    } as BotBoundaryReport['botClosure'];
    const okR2 = { scanned: 500, blind: false, unreadable: 0, findings: [], summary: 'ok' } as BotBoundaryReport['reverseIntoBot'];
    const okR3 = { scanned: 900, blind: false, unreadable: 0, findings: [], typeOnlyRefs: [], summary: 'ok' } as BotBoundaryReport['clientAxis'];

    expect(isBotBoundaryClean({ botClosure: measured, reverseIntoBot: okR2, clientAxis: okR3 })).toBe(true);

    // A half-scaffolded package directory: present, but nothing scannable.
    expect(
      isBotBoundaryClean({
        botClosure: { ...measured, status: 'blind', seeds: 0, walked: 0 },
        reverseIntoBot: okR2,
        clientAxis: okR3,
      }),
    ).toBe(false);

    // Any finding, on any rule.
    expect(
      isBotBoundaryClean({
        botClosure: { ...measured, findings: [{ owner: '@duya/host', file: 'x', via: null, chain: ['x'] }] },
        reverseIntoBot: okR2,
        clientAxis: okR3,
      }),
    ).toBe(false);
    expect(
      isBotBoundaryClean({
        botClosure: measured,
        reverseIntoBot: { ...okR2, findings: [{ from: 'a', spec: 'b', to: 'c' }] },
        clientAxis: okR3,
      }),
    ).toBe(false);
    expect(
      isBotBoundaryClean({
        botClosure: measured,
        reverseIntoBot: okR2,
        clientAxis: { ...okR3, findings: [{ from: 'a', spec: 'b', to: 'c', target: 'packages/host/' }] },
      }),
    ).toBe(false);

    // Blind denominators.
    expect(
      isBotBoundaryClean({
        botClosure: measured,
        reverseIntoBot: { ...okR2, blind: true },
        clientAxis: okR3,
      }),
    ).toBe(false);
    expect(
      isBotBoundaryClean({
        botClosure: measured,
        reverseIntoBot: okR2,
        clientAxis: { ...okR3, blind: true },
      }),
    ).toBe(false);
  });
});

describe('census: the S0 consumer inventory stays discoverable', () => {
  it('finds the migration-table groups with members and consumers', () => {
    const { rows, unreadable } = botCensus();
    expect(unreadable).toBe(0);
    expect(rows.length).toBe(BOT_SURFACE_GROUPS.length);

    const byName = new Map(rows.map((r) => [r.group, r]));

    // The host bot prompt modules: the migration's biggest consumer is the
    // RETIRING `packages/agent` layer, not desktop. That is the load-bearing
    // S0 fact — if this assertion starts failing, a slice moved bot prompt
    // ownership, and the census must be updated in the same PR rather than
    // silenced.
    const prompts = byName.get('host/worker-prompts/bot')!;
    expect(prompts.members).toBeGreaterThanOrEqual(20);
    expect(prompts.consumers.some((c) => c.startsWith('packages/agent/'))).toBe(true);
    expect(prompts.consumers.some((c) => c.startsWith('apps/desktop/'))).toBe(true);

    // The durable wake substrate exists and is consumed outside data itself.
    const wakes = byName.get('data/pending-wakes')!;
    expect(wakes.members).toBe(1);
    expect(wakes.consumers.some((c) => c.startsWith('packages/host/'))).toBe(true);

    // The desktop-owned scheduling surface the migration plans to retire.
    const wakeGroup = byName.get('desktop/wake/*')!;
    expect(wakeGroup.members).toBeGreaterThan(0);
    expect(wakeGroup.consumers.some((c) => c.startsWith('apps/desktop/src/main/ipc/'))).toBe(true);

    // The client surface is inside the ui package and consumed by chat views.
    const uiGroup = byName.get('ui/chat/bot* (components)')!;
    expect(uiGroup.members).toBeGreaterThanOrEqual(30);
  }, 300_000);
});
