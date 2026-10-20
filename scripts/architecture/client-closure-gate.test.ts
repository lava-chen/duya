/**
 * client-closure-gate.test.ts — the directions gate G11-1 has to satisfy.
 *
 * ## The card asked for three mutations. Two of them do not exist on this tree.
 *
 * `19-fast-track-queue.md` T14 specifies: "注入 RunEngineImpl 值导入 → 红；还原
 * → 绿；把入口换成空文件 → 红". Measured before writing a line of this gate: the
 * tree is ALREADY red, so neither "inject → red" nor "empty the entry → red" is
 * an observable transition — the first has nowhere to go, and the second cannot
 * make an already-red gate redder.
 *
 * The transitions are therefore proven where they are real — on a fixture — and
 * the live tree's redness is asserted as a FACT with its exact shape, including
 * the edge that has to be severed and the card that owns severing it. That is
 * stronger than the original plan: the fixture proves the detector has teeth in
 * both directions, and the live assertions prove it is currently biting the real
 * thing rather than a hypothetical one.
 *
 * ## What is NOT done
 *
 * No baseline, no fingerprint, no allow-list. 19 §9 makes `architecture:check` a
 * ratchet that may not absorb its own edges, and "the tree is red, so record it"
 * is exactly that absorption. The gate exits 1 today and will exit 0 the day the
 * `chat.ts` edge is severed, with no edit here.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT, importsOf } from './import-graph.mjs';
import {
  CLIENT_ENTRIES,
  FORBIDDEN_PACKAGES,
  clientClosure,
  collectClientClosureReport,
  forbiddenOwnerOf,
  isClientClosureClean,
  isEveryClientEntryClean,
  isMeasured,
  pathTo,
} from './client-closure-gate.mjs';
import type { ClientClosureEntryReport } from './client-closure-gate.ts';

/**
 * The fixture lives INSIDE `packages/cli/src/`, which is a scanned package tree.
 *
 * `browser-closure-gate.test.ts` records why placement matters: a fixture parked
 * outside every scanned root produces an empty closure from the start, so the
 * gate reports "nothing found" regardless of what the fixture contains. Here the
 * roots are FILES (`chat.ts`, `client-core/src/index.ts`), so the fixture is not
 * picked up by accident — it is reached only through the relative import the
 * test writes, which is the edge under test. The directory is removed in a
 * `finally` regardless.
 */
const FIXTURE = 'packages/cli/src/__g11_1_fixture__';
const FIXTURE_ENTRY = `${FIXTURE}/entry.ts`;

function writeFixture(files: Record<string, string>): void {
  const dir = path.join(ROOT, FIXTURE);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    // `__tests__/helper.ts` and friends nest; a flat mkdirSync throws ENOENT and,
    // worse, throws BEFORE the try/finally, leaving the fixture on disk for every
    // later assertion in this file.
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, 'utf8');
  }
}

function dropFixture(): void {
  rmSync(path.join(ROOT, FIXTURE), { recursive: true, force: true });
}

/** Measure the fixture entry alone, so the live entries do not dilute the count. */
function reportForFixture(): ClientClosureEntryReport {
  return collectClientClosureReport([{ rel: FIXTURE_ENTRY, kind: 'file' }])[0];
}

describe('G11-1 goes RED when a client entry value-imports the runtime', () => {
  it('reports the runtime, the edge to sever, and the chain to it', () => {
    // Two hops on purpose. A gate that only inspects the entry's own imports
    // would pass this, and "one convenient import, one directory deeper" is the
    // shape the real regression has (`chat.ts -> local-host -> ... -> runtime`).
    writeFixture({
      'entry.ts': "export { start } from './hop-local-host.js';\n",
      'hop-local-host.ts': "export { run } from './hop-run-execution.js';\n",
      'hop-run-execution.ts':
        "import { RunEngineImpl } from '@duya/agent-runtime';\nexport const run = RunEngineImpl;\n",
    });
    try {
      const report = reportForFixture();
      expect(isClientClosureClean(report)).toBe(false);

      // Both, and the second is a consequence, not a second cause: the runtime
      // barrel itself value-imports `@duya/agent-core`, so entering the runtime
      // necessarily enters core. The report names each package's FIRST entrance,
      // which is why both findings point at distinct edges in the chain.
      expect(report.findings.map((f) => f.package)).toEqual([
        '@duya/agent-runtime',
        '@duya/agent-core',
      ]);

      const finding = report.findings[0];
      expect(finding.file).toBe('packages/agent-runtime/src/index.ts');
      expect(finding.via).toBe(`${FIXTURE}/hop-run-execution.ts`);
      expect(finding.chain).toEqual([
        FIXTURE_ENTRY,
        `${FIXTURE}/hop-local-host.ts`,
        `${FIXTURE}/hop-run-execution.ts`,
        'packages/agent-runtime/src/index.ts',
      ]);

      // Non-vacuous: one seed plus three hops plus whatever the runtime barrel
      // itself reaches. The floor is what matters — zero would be the blind case.
      expect(report.walked).toBeGreaterThan(3);
    } finally {
      dropFixture();
    }
  });

  it('is GREEN on the same fixture once the edge is demoted to `import type`', () => {
    // The negative direction. Without it the assertion above could pass because
    // the gate reports a finding for any input at all. This is also the exact
    // mutation a developer would apply to "fix" the gate rather than the code —
    // and it is legal here because a type-only reference is erased by tsc.
    //
    // `hop-local-host.ts` carries BOTH kinds on purpose: a value edge keeps it
    // inside the closure (so the closure is non-empty and the green is not the
    // `0/0` shape), and a type-only edge names the runtime without reaching it.
    writeFixture({
      'entry.ts': "export { start } from './hop-local-host.js';\n",
      'hop-local-host.ts': [
        "import type { RunEngineImpl } from '@duya/agent-runtime';",
        "export { localFlag } from './hop-leaf.js';",
        'export type run = RunEngineImpl;',
        '',
      ].join('\n'),
      'hop-leaf.ts': 'export const localFlag = true;\n',
    });
    try {
      const report = reportForFixture();
      expect(report.findings).toEqual([]);
      expect(isClientClosureClean(report)).toBe(true);

      // A type-only reference is NOT thrown away silently: it is counted, so a
      // reader can see the treatment instead of inferring it from an absence.
      // (A type-only file that is reachable ONLY by type edges is not in the
      // closure at all and therefore not scanned — see the next test.)
      expect(report.typeOnlyRefs.map((r) => r.spec)).toContain('@duya/agent-runtime');

      // Still walked something, so this green is not the `0/0` shape.
      expect(report.walked).toBe(3);
      expect(report.summary).toBe(`0/${report.walked} forbidden packages in ${FIXTURE_ENTRY}`);
    } finally {
      dropFixture();
    }
  });

  it('is RED — not green — when the entry does not exist', () => {
    // The third direction, and the one the card was really after ("防什么都没扫到
    // 的假绿"). A missing root is the quietest blind state: the walk opens nothing,
    // every count is zero, and a `findings.length === 0` verdict calls it clean.
    const report = collectClientClosureReport([
      { rel: 'packages/cli/src/__does_not_exist__.ts', kind: 'file' },
    ])[0];
    expect(report.absent).toBe(true);
    expect(report.walked).toBe(0);
    expect(report.findings).toEqual([]);
    // The verdict, despite zero findings:
    expect(report.clean).toBe(false);
    expect(isClientClosureClean(report)).toBe(false);
    expect(report.summary).toBe('absent: packages/cli/src/__does_not_exist__.ts');
  });

  it('is RED — not green — when the entry is empty', () => {
    // Found by mutation, not by reading the code: the first version of this gate
    // guarded with `walked > 0`, and emptying the root left `walked === 1`
    // (the entry itself) with zero findings, which that guard called CLEAN.
    // That is precisely the "什么都没扫到" false green the card names.
    writeFixture({ 'entry.ts': '' });
    try {
      const report = reportForFixture();
      expect(report.absent).toBe(false);
      // One file: the entry, and only the entry.
      expect(report.walked).toBe(1);
      expect(report.findings).toEqual([]);
      // The verdict, despite zero findings:
      expect(report.clean).toBe(false);
      expect(isClientClosureClean(report)).toBe(false);
      expect(isMeasured(report)).toBe(false);
    } finally {
      dropFixture();
    }
  });

  it('is RED — not green — when the entry has no value imports to follow', () => {
    // Same guard, one step less degenerate: the file exists and has content, but
    // only a type-only edge, so the value closure is still just the entry.
    writeFixture({
      'entry.ts': "import type { RunEvent } from '@duya/agent-runtime';\nexport type E = RunEvent;\n",
    });
    try {
      const report = reportForFixture();
      expect(report.walked).toBe(1);
      expect(report.findings).toEqual([]);
      expect(isClientClosureClean(report)).toBe(false);
    } finally {
      dropFixture();
    }
  });

  it('treats agent-core as forbidden on its own, not only behind the runtime', () => {
    // A client that reaches core directly is the same coupling one hop shorter,
    // and the gate must not depend on the runtime barrel being in the path.
    writeFixture({
      'entry.ts': "import { runReasoning } from '@duya/agent-core';\nexport const x = runReasoning;\n",
    });
    try {
      const report = reportForFixture();
      expect(report.findings.map((f) => f.package)).toEqual(['@duya/agent-core']);
      expect(report.findings[0].via).toBe(FIXTURE_ENTRY);
    } finally {
      dropFixture();
    }
  });
});

describe('G11-1 on the live tree', () => {
  const reports = collectClientClosureReport();

  it('measures every root, named, one report each', () => {
    expect(reports.map((r) => r.entry)).toEqual([
      'packages/client-core/src/index.ts',
      'packages/cli/src/chat.ts',
      'packages/cli/src/tui/index.ts',
    ]);
    expect(reports.every((r) => r.absent === false)).toBe(true);
  });

  it('keeps `@duya/client-core` clean and SMALL — that is the point of the root', () => {
    // This root exists to stay tiny. It is the one entry whose closure should
    // never grow, so it is asserted as a small floor/ceiling rather than a bare
    // `> 0`: a regression that pulled `@duya/host` in here would still be `> 0`.
    //
    // Before `import-graph.mjs`'s type-only fix this reported 66, because a
    // 22-line `import type` in `surface-model.ts` was misclassified as a value
    // import and dragged all of `@duya/agent-protocol` in. The real coupling is
    // one module. Both numbers are recorded here so the next reader does not
    // re-diagnose it.
    const core = reports[0];
    expect(isClientClosureClean(core)).toBe(true);
    expect(core.findings).toEqual([]);
    expect(core.walked).toBeGreaterThan(0);
    expect(core.walked).toBeLessThan(10);
  });

  it('reports the CLI entry CLEAN — the four-hop chain is severed at the source', () => {
    // The chain this gate was written for was
    //   chat.ts → host/local-host.ts → run-execution.ts → run-orchestrator.ts
    //          → agent-runtime
    // and it is gone: `runTuiCommand` moved into `packages/cli/src/tui-command.ts`,
    // so the only value import of `@duya/host/local-host` is in the bootstrap
    // (`tui-command.ts` and `index.ts`), which is not a client entry.
    //
    // Asserted as a FACT, not absorbed: if someone wires the Host back into
    // `chat.ts`, this test goes red and names the edge that did it.
    const cli = reports[1];
    expect(isClientClosureClean(cli)).toBe(true);
    expect(cli.findings).toEqual([]);

    // The closure is large, so this green is not the "inspected nothing" shape.
    expect(cli.walked).toBeGreaterThan(200);
  });

  it('states the whole verdict with the denominator, not a bare count', () => {
    // `<bad>/<walked>` per entry and `3/3 entries clean` overall: a number
    // without its denominator cannot be read, and cannot be told apart from
    // a collapse.
    expect(reports[0].summary).toBe(
      `0/${reports[0].walked} forbidden packages in packages/client-core/src/index.ts`,
    );
    expect(reports[1].summary).toBe(
      `0/${reports[1].walked} forbidden packages in packages/cli/src/chat.ts`,
    );
    expect(reports[2].summary).toBe(
      `0/${reports[2].walked} forbidden packages in packages/cli/src/tui/index.ts`,
    );
    expect(isEveryClientEntryClean(reports)).toBe(true);
  });

  it('walks into the runtime only through host, never directly from the client', () => {
    // This is the assertion that makes the finding actionable. If `chat.ts` had
    // imported `@duya/agent-runtime` itself, the fix would be one line in the CLI;
    // it does not, so the fix belongs to `packages/host` (or to the CLI turning
    // `startLocalHost` into a dynamic import at its single call site).
    for (const entry of ['packages/cli/src/chat.ts', 'packages/cli/src/tui/index.ts']) {
      const direct = importsOf(path.join(ROOT, entry)).filter((i) =>
        FORBIDDEN_PACKAGES.some((p) => i.spec === p || i.spec.startsWith(`${p}/`)),
      );
      expect(direct, entry).toEqual([]);
    }
  });
});

describe('the forbidden-package test is a package test, not a prefix test', () => {
  it('maps files to their owning package, and nothing else', () => {
    expect(forbiddenOwnerOf('packages/agent-runtime/src/index.ts')).toBe('@duya/agent-runtime');
    expect(forbiddenOwnerOf('packages/agent-core/src/run-reasoning.ts')).toBe('@duya/agent-core');
  });

  it('does not claim a package whose name merely starts the same way', () => {
    // `packages/agent-runtime-legacy`-shaped paths must not be captured, and the
    // legacy shell itself (`packages/agent`) is a different package.
    for (const file of [
      'packages/agent-runtime-legacy/src/index.ts',
      'packages/agent/src/index.ts',
      'packages/agent-protocol/src/index.ts',
      'packages/host/src/local-host.ts',
    ]) {
      expect({ file, owner: forbiddenOwnerOf(file) }).toEqual({ file, owner: null });
    }
  });
});

describe('the closure follows value edges only, and reports the path', () => {
  it('does not traverse a type-only hop to reach the runtime', () => {
    writeFixture({
      'entry.ts': "export type { t } from './hop-type.js';\n",
      'hop-type.ts':
        "import type { RunEvent } from '@duya/agent-runtime';\nexport type t = RunEvent;\n",
    });
    try {
      const closure = clientClosure(FIXTURE_ENTRY);
      expect(closure).not.toBeNull();
      // The entry itself only, because its single edge is type-only.
      expect([...(closure?.keys() ?? [])]).toEqual([FIXTURE_ENTRY]);
    } finally {
      dropFixture();
    }
  });

  it('names the whole chain between a file and its entry', () => {
    writeFixture({
      'entry.ts': "export { a } from './hop-a.js';\n",
      'hop-a.ts': "export { b } from './hop-b.js';\n",
      'hop-b.ts': 'export const b = 1;\n',
    });
    try {
      const closure = clientClosure(FIXTURE_ENTRY);
      expect(pathTo(closure as Map<string, string | null>, `${FIXTURE}/hop-b.ts`)).toEqual([
        FIXTURE_ENTRY,
        `${FIXTURE}/hop-a.ts`,
        `${FIXTURE}/hop-b.ts`,
      ]);
    } finally {
      dropFixture();
    }
  });

  it('does not count test files as edges', () => {
    // `isTestPath` — the rule every boundary gate applies. A test may construct
    // the runtime; it is not a runtime coupling in a shipped client.
    writeFixture({
      'entry.ts': "export { a } from './hop-a.js';\n",
      'hop-a.ts': "export { helper } from './__tests__/helper.js';\nexport const a = helper;\n",
      '__tests__/helper.ts':
        "import { RunEngineImpl } from '@duya/agent-runtime';\nexport const helper = RunEngineImpl;\n",
    });
    try {
      const report = reportForFixture();
      expect(report.findings).toEqual([]);
      expect(report.walked).toBe(2);
    } finally {
      dropFixture();
    }
  });
});

describe('the gate reads the tree, not a fixture it left behind', () => {
  it('has no fixture directory on disk', () => {
    // If a previous run's fixture survived, the live-tree counts above would be
    // measured against a polluted tree and still look plausible.
    expect(existsSync(path.join(ROOT, FIXTURE))).toBe(false);
  });

  it('keeps its entry list in step with the card', () => {
    // `CLIENT_ENTRIES` is the scope of the verdict; a silent edit here would
    // shrink what "PASS" covers without touching any assertion above.
    expect(CLIENT_ENTRIES.map((e) => e.rel)).toEqual([
      'packages/client-core/src/index.ts',
      'packages/cli/src/chat.ts',
      'packages/cli/src/tui/index.ts',
    ]);
    expect(CLIENT_ENTRIES.every((e) => e.kind === 'file')).toBe(true);
  });
});

describe('the TUI is a client surface, and the gate now measures it', () => {
  const reports = collectClientClosureReport();

  it('measures it — a new entry that scans nothing is a false green', () => {
    // The same shape the gate was written to defend: an entry that is absent,
    // or whose closure is just the entry itself, proves nothing. The TUI
    // entry is registered so that a future import that drags the runtime
    // into the renderer is reported HERE rather than by accident through
    // `chat.ts`.
    const tui = reports[2];
    expect(tui).toBeDefined();
    expect(tui?.entry).toBe('packages/cli/src/tui/index.ts');
    expect(tui?.absent).toBe(false);
    expect(tui?.walked).toBeGreaterThan(1);
  });
});
