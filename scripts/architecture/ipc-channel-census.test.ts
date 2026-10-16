/**
 * Plan 610 §14 P0 — worker IPC channel census tests.
 *
 * ## Why every rule below has a fixture
 *
 * `boundary-gates.test.ts` records the reason: a gate that reports a fact
 * without checking anything is worse than a red test, because the next slice
 * trusts it. The census has three rules (`exactly`, `min`, `consensus`) and each
 * one can silently degenerate:
 *
 *  - `exactly` always-green if the probe string never matches anything;
 *  - `consensus` always-green if the majority is computed from a single sample;
 *  - `min` always-green if absence is never observed.
 *
 * So each rule is exercised against a **planted fixture carrying the violation
 * it forbids**, asserted to be found, and paired with a fully-correct control
 * that must report nothing. The live-tree block at the bottom is the ledger; it
 * only asserts what those proven detectors currently say.
 */

import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectIpcChannelCensus, discoverChannels } from './ipc-channel-census.js';
import type { IpcChannelCensusReport } from './ipc-channel-census.js';

const FIXTURE_CHANNELS = ['alpha:rpc', 'beta:execute', 'gamma:cua', 'delta:invoke'];

interface TreeOptions {
  /** Channels that must NOT get an inbound `<channel>:response` case. */
  omitResponseCase?: string[];
  /** Channels that must NOT get a `sendToMain({ type })` outbound literal. */
  omitOutbound?: string[];
  /** Channels missing from the Host worker-manager drop list. */
  whitelistOmit?: string[];
  /** Channels missing from the inter-agent forwarder. */
  interagentOmit?: string[];
  /** How many copies of each forward the agent-server router carries. */
  routerCopies?: number;
}

function writeFile(root: string, relPath: string, contents: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
}

function buildTree(options: TreeOptions = {}): string {
  const {
    omitResponseCase = [],
    omitOutbound = [],
    whitelistOmit = [],
    interagentOmit = [],
    routerCopies = 1,
  } = options;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ipc-census-'));

  const outbound = FIXTURE_CHANNELS
    .filter((channel) => !omitOutbound.includes(channel))
    .map((channel) => `sendToMain({ type: '${channel}', requestId });`)
    .join('\n');
  const responseCases = FIXTURE_CHANNELS
    .filter((channel) => !omitResponseCase.includes(channel))
    .map((channel) => `        case '${channel}:response': { resolve(); break; }`)
    .join('\n');
  writeFile(root, 'packages/host/src/worker-process-entry.ts', [
    'function sendToMain(_payload: unknown): void {}',
    'function handle(msg: { type?: string }): void {',
    outbound,
    '  switch (msg.type) {',
    responseCases,
    "        case 'db:response': { break; }",
    '  }',
    '}',
  ].join('\n'));

  const dropped = FIXTURE_CHANNELS
    .filter((channel) => !whitelistOmit.includes(channel))
    .map((channel) => `msg.type === '${channel}'`)
    .join(' || ');
  writeFile(root, 'packages/host/src/worker-manager.ts', [
    'function onChildMessage(msg: { type?: string }): void {',
    `  if (${dropped || 'false'}) { return; }`,
    '  forward(msg);',
    '}',
  ].join('\n'));

  writeFile(
    root,
    'apps/desktop/src/main/agents/agent-server-lifecycle.ts',
    FIXTURE_CHANNELS
      .map((channel) => `if (msg.type === '${channel}') { respond({ type: '${channel}:response' }); }`)
      .join('\n'),
  );

  const routerBlock = FIXTURE_CHANNELS
    .map((channel) => `if (msg.type === '${channel}' && process.send) { process.send(msg); }`)
    .join('\n');
  writeFile(
    root,
    'apps/desktop/src/main/agents/server/router.ts',
    Array.from({ length: routerCopies }, (_, index) => `// copy ${index + 1}\n${routerBlock}`).join('\n'),
  );

  const interagent = FIXTURE_CHANNELS
    .filter((channel) => !interagentOmit.includes(channel))
    .map((channel) => `if (msg.type === '${channel}' && process.send) { process.send(msg); }`)
    .join('\n');
  writeFile(
    root,
    'apps/desktop/src/main/agents/server/interagent-router.ts',
    interagent || '// no forwards\n',
  );

  writeFile(
    root,
    'apps/desktop/src/main/agents/server/index.ts',
    FIXTURE_CHANNELS
      .map((channel) => `if (msg.type === '${channel}:response') { relay(msg); }`)
      .join('\n'),
  );

  return root;
}

const created: string[] = [];
function tree(options?: TreeOptions): string {
  const root = buildTree(options);
  created.push(root);
  return root;
}

afterAll(() => {
  for (const root of created) fs.rmSync(root, { recursive: true, force: true });
});

function findingsFor(report: IpcChannelCensusReport, site: string) {
  return report.findings.filter((finding) => finding.site === site);
}

describe('channel discovery', () => {
  it('derives the universe from both witnesses and excludes the db bridge', () => {
    const report = collectIpcChannelCensus(tree());
    expect(report.channels).toEqual([...FIXTURE_CHANNELS].sort());
  });

  it('picks up a newly added channel purely from its response case', () => {
    const root = tree();
    const entry = path.join(root, 'packages/host/src/worker-process-entry.ts');
    const original = fs.readFileSync(entry, 'utf8');
    fs.writeFileSync(
      entry,
      `${original}\n// later\nfunction more(msg: { type?: string }): void {\n  switch (msg.type) {\n    case 'epsilon:rpc:response': { break; }\n  }\n}\n`,
      'utf8',
    );
    expect(discoverChannels(root)).toContain('epsilon:rpc');
  });

  it('survives the loss of one witness, so a deletion cannot hide a channel', () => {
    // Witness A deleted for beta; witness B (Main's emission) still names it.
    const root = tree({ omitResponseCase: ['beta:execute'] });
    expect(discoverChannels(root)).toContain('beta:execute');
  });

  it('documents the residual limit: both witnesses gone means the channel is invisible', () => {
    const root = tree();
    for (const relPath of [
      'packages/host/src/worker-process-entry.ts',
      'apps/desktop/src/main/agents/agent-server-lifecycle.ts',
    ]) {
      const abs = path.join(root, relPath);
      const text = fs.readFileSync(abs, 'utf8')
        .split('\n')
        .filter((line) => !(line.includes(':response') && line.includes('gamma:cua')))
        .join('\n');
      fs.writeFileSync(abs, text, 'utf8');
    }
    // With both witnesses removed the census cannot invent the channel back.
    // That is the stated limit of derivation, encoded here so it stays honest.
    expect(discoverChannels(root)).not.toContain('gamma:cua');
  });
});

describe('control: a fully-synced tree reports nothing', () => {
  it('has no error, asymmetry, or duplicate findings', () => {
    const report = collectIpcChannelCensus(tree());
    expect(report.findings).toEqual([]);
  });
});

describe('exactly rule (worker inbound response case)', () => {
  it('flags a channel whose response case is missing', () => {
    const report = collectIpcChannelCensus(tree({ omitResponseCase: ['beta:execute'] }));
    const findings = findingsFor(report, 'worker-inbound-response');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].channel).toBe('beta:execute');
  });
});

describe('exactly rule (agent-server router forward)', () => {
  it('flags each extra copy of the same condition', () => {
    const report = collectIpcChannelCensus(tree({ routerCopies: 3 }));
    const findings = findingsFor(report, 'server-forward-router');
    // One finding per channel (each describing its two surplus copies).
    expect(findings).toHaveLength(FIXTURE_CHANNELS.length);
    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(['duplicate']));
    expect(findings.every((finding) => finding.message.includes('重复 2 处'))).toBe(true);
    // The finding points at every physical line so the copy sites are visible.
    expect(findings[0].lines).toHaveLength(3);
  });

  it('flags a missing forward when the router carries none', () => {
    const report = collectIpcChannelCensus(tree({ routerCopies: 0 }));
    const findings = findingsFor(report, 'server-forward-router');
    expect(findings).toHaveLength(FIXTURE_CHANNELS.length);
    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(['error']));
  });
});

describe('min rule (worker outbound dispatch)', () => {
  it('flags a channel with no outbound literal', () => {
    const report = collectIpcChannelCensus(tree({ omitOutbound: ['gamma:cua'] }));
    const findings = findingsFor(report, 'worker-outbound');
    expect(findings).toHaveLength(1);
    expect(findings[0].channel).toBe('gamma:cua');
    expect(findings[0].severity).toBe('error');
  });
});

describe('consensus rule (undeclared asymmetry)', () => {
  it('flags a channel missing from the Host worker-manager drop list', () => {
    const report = collectIpcChannelCensus(tree({ whitelistOmit: ['alpha:rpc'] }));
    const findings = findingsFor(report, 'host-manager-drop');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('asymmetry');
    expect(findings[0].channel).toBe('alpha:rpc');
  });

  it('flags a channel missing from the inter-agent forwarder', () => {
    const report = collectIpcChannelCensus(tree({ interagentOmit: ['alpha:rpc', 'beta:execute'] }));
    const findings = findingsFor(report, 'server-forward-interagent');
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(['asymmetry']));
  });
});

/**
 * Ledger block. These assertions pin what the proven detectors above currently
 * say about the real repository, so a change in the red set is visible in a
 * diff. P1/P2 of doc 14 are expected to move these numbers; updating them is
 * the point, not a regression.
 */
describe('live tree ledger', () => {
  it('reports no missing site for any channel', () => {
    const report = collectIpcChannelCensus();
    const errors = report.findings.filter((finding) => finding.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('knows the current channel universe', () => {
    const report = collectIpcChannelCensus();
    expect(report.channels).toEqual([
      'appConnection:catalog',
      'appConnection:invoke',
      'appConnection:listDescriptors',
      'bot-identity:rpc',
      'computer-use:cua',
      'computer-use:execute',
      'conductor:executor:rpc',
      'memory-tier:rpc',
    ]);
  });

  it('pins the current structural debt (asymmetry 5 / duplicate 8)', () => {
    const report = collectIpcChannelCensus();
    const tally = { error: 0, asymmetry: 0, duplicate: 0 };
    for (const finding of report.findings) tally[finding.severity as keyof typeof tally] += 1;
    expect(tally).toEqual({ error: 0, asymmetry: 5, duplicate: 8 });
  });

  it('attributes the duplicates to the router and the asymmetries to the two known sites', () => {
    const report = collectIpcChannelCensus();
    expect(new Set(report.findings.filter((f) => f.severity === 'duplicate').map((f) => f.site)))
      .toEqual(new Set(['server-forward-router']));
    expect(new Set(report.findings.filter((f) => f.severity === 'asymmetry').map((f) => f.site)))
      .toEqual(new Set(['host-manager-drop', 'server-forward-interagent']));
  });
});
