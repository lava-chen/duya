#!/usr/bin/env node
/**
 * Worker IPC channel census — plan 610 series, doc 14, phase P0.
 *
 * ## The problem this measures
 *
 * A single worker IPC request channel costs **seven hand-synced sites** across
 * `packages/host` and `apps/desktop` today. Adding one means editing all of
 * them; missing one produces no compile error and no gate failure — only a
 * runtime `UNKNOWN_ACTION`, or a silent 15s / 30s timeout. Plan 454 and plan
 * 575 each lost a round to exactly this. The constraint is currently enforced
 * by nothing but the author remembering to touch seven places.
 *
 * This script is a **read-only reporter** (P0). It changes no behaviour and
 * writes no file: it derives the channel universe, counts every site, and
 * prints the matrix plus every deviation so the red set is visible before any
 * refactor lands. Wiring it into `architecture:check` is P3.
 *
 * ## How the channel universe is derived
 *
 * Not from a hand-maintained list — a list would just be an eighth place to
 * forget. A channel is read off the two artefacts that a request/response pair
 * cannot exist without, in two different files, and their **union** is the
 * universe:
 *
 *  - **Witness A — the worker's inbound case**: `case '<channel>:response':`
 *    in `RESPONSE_OWNER`. Without it the worker can never resolve its pending
 *    promise.
 *  - **Witness B — Main's outbound emission**: `type: '<channel>:response'` in
 *    `RESPONSE_EMITTER`. Without it nothing ever answers the request.
 *
 * Two witnesses rather than one, deliberately. A single-witness universe built
 * from witness A cannot detect its own failure mode: delete that `case` line and
 * the channel silently leaves the universe, so the census reports a clean tree
 * for a channel that now hangs. The union means a channel disappears only when
 * *both* independent artefacts are gone.
 *
 * The residual limit is stated rather than hidden: a channel invented in a third
 * shape (request and response written somewhere else entirely) is invisible
 * here. This is a consistency checker across known sites, not an oracle.
 *
 * `db` is excluded by name: the DB bridge is a different transport family (the
 * DB client registers its own listener and answers over `db:request` /
 * `db:response`), not a tool/IPC request channel routed through the Main-process
 * dispatcher. One-way notifications need no exclusion — `bash_task:update` and
 * `hook_task:update` are matched by neither witness because neither is ever
 * answered, which is exactly the property being asserted.
 *
 * ## Rules, and why they are shaped this way
 *
 * - `exactly` — one occurrence, no more, no fewer. Catches both a missing
 *   forward AND an accidental copy-paste duplicate.
 * - `min` — at least one. Used where a variant split is legitimate (the worker
 *   outbound dispatch has several helpers).
 * - `consensus` — the site's per-channel count must match the majority profile.
 *   Some sites are legitimately asymmetric, but "legitimate" must be declared,
 *   not assumed; an undeclared absence is exactly the 454/575 failure mode.
 *
 * Usage:
 *   node scripts/architecture/ipc-channel-census.mjs
 *   node scripts/architecture/ipc-channel-census.mjs --json
 *   node scripts/architecture/ipc-channel-census.mjs --strict   # exit 1 on error/asymmetry
 *   node scripts/architecture/ipc-channel-census.mjs --root <repo>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './strip-comments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

/** Witness A — the worker's inbound `<channel>:response` cases. */
const RESPONSE_OWNER = 'packages/host/src/worker-process-entry.ts';

/** Witness B — Main's outbound `<channel>:response` emissions. */
const RESPONSE_EMITTER = 'apps/desktop/src/main/agents/agent-server-lifecycle.ts';

/** Endpoints that are a different transport family, not a routed channel. */
const EXCLUDED_CHANNELS = new Set(['db']);

/**
 * A site = one physical place that must mention every channel, expressed as a
 * literal substring probe. `extra` is an informational second probe: it is
 * counted and shown but never fails the gate, because a site may legitimately
 * reach the same channel through more than one code shape.
 */
const SITES = [
  {
    id: 'worker-outbound',
    title: 'worker → Main 出站分发',
    file: 'packages/host/src/worker-process-entry.ts',
    probe: (channel) => `type: '${channel}'`,
    extra: (channel) => `channel === '${channel}'`,
    extraLabel: 'toolIpcRequest 分支',
    rule: { kind: 'min', value: 1 },
    note: 'sendToMain({ type: <channel> }) 字面量',
  },
  {
    id: 'worker-inbound-response',
    title: 'worker ← Main 入站 (response case)',
    file: 'packages/host/src/worker-process-entry.ts',
    probe: (channel) => `case '${channel}:response':`,
    rule: { kind: 'exactly', value: 1 },
    note: '信封解包 + pending 兑现',
  },
  {
    id: 'host-manager-drop',
    title: 'Host worker-manager 丢弃白名单',
    file: 'packages/host/src/worker-manager.ts',
    probe: (channel) => `msg.type === '${channel}'`,
    rule: { kind: 'consensus' },
    note: '命中的通道被 Host manager 丢弃（由 Desktop router 接管）；未命中的会流向 onWorkerMessage',
  },
  {
    id: 'main-execute-route',
    title: 'Main 执行侧路由',
    file: 'apps/desktop/src/main/agents/agent-server-lifecycle.ts',
    probe: (channel) => `msg.type === '${channel}'`,
    rule: { kind: 'min', value: 1 },
    note: '真正执行并回写 <channel>:response 的分支',
  },
  {
    id: 'server-forward-router',
    title: 'Agent Server 转发 (router 全变体)',
    file: 'apps/desktop/src/main/agents/server/router.ts',
    probe: (channel) => `msg.type === '${channel}'`,
    rule: { kind: 'exactly', value: 1 },
    note: '同一条件本应只有一处；>1 即复制品异味',
  },
  {
    id: 'server-forward-interagent',
    title: 'Agent Server 跨 agent 转发',
    file: 'apps/desktop/src/main/agents/server/interagent-router.ts',
    probe: (channel) => `msg.type === '${channel}'`,
    rule: { kind: 'consensus' },
    note: '子 agent 场景的转发；缺此站点会导致跨 agent 调用静默超时',
  },
  {
    id: 'server-response-relay',
    title: 'Agent Server 响应回传 worker',
    file: 'apps/desktop/src/main/agents/server/index.ts',
    probe: (channel) => `msg.type === '${channel}:response'`,
    rule: { kind: 'min', value: 1 },
    note: 'workerDbRequests 登记表 → workerChild.send',
  },
];

/** Witness A: the worker's inbound `case '<channel>:response':` lines. */
const RESPONSE_CASE_RE = /\bcase\s+'([^'\r\n]+):response'/g;

/** Witness B: Main's outbound `type: '<channel>:response'` emissions. */
const RESPONSE_EMIT_RE = /\btype:\s*'([^'\r\n]+):response'/g;

function readStripped(root, relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  // stripComments preserves byte offsets and newlines, so line numbers stay
  // honest and a doc comment mentioning a channel cannot inflate a count.
  const { text, unterminated } = stripComments(raw);
  const source = unterminated ? raw : text;
  return { text: source, lines: source.split(/\r?\n/) };
}

/** All (`1-based line`, text) pairs where `needle` occurs. */
function findHits(source, needle) {
  const hits = [];
  for (let index = 0; index < source.lines.length; index += 1) {
    if (source.lines[index].includes(needle)) {
      hits.push({ line: index + 1, text: source.lines[index].trim() });
    }
  }
  return hits;
}

/**
 * Derive the channel universe as the union of the two independent witnesses.
 *
 * @returns {string[]} channel names, sorted
 */
export function discoverChannels(root = REPO_ROOT) {
  const owner = readStripped(root, RESPONSE_OWNER);
  if (owner === null) {
    throw new Error(`cannot discover channels: ${RESPONSE_OWNER} not found under ${root}`);
  }
  const emitter = readStripped(root, RESPONSE_EMITTER);

  const channels = new Set();
  const collect = (source, pattern) => {
    if (source === null) return;
    for (const match of source.text.matchAll(pattern)) {
      const channel = match[1].trim();
      if (channel.length === 0 || EXCLUDED_CHANNELS.has(channel)) continue;
      channels.add(channel);
    }
  };
  collect(owner, RESPONSE_CASE_RE);
  collect(emitter, RESPONSE_EMIT_RE);

  return [...channels].sort();
}

function majorityProfile(counts) {
  const tally = new Map();
  for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);
  let best = null;
  for (const [value, seen] of tally) {
    if (best === null || seen > best.seen || (seen === best.seen && value > best.value)) {
      best = { value, seen };
    }
  }
  return best;
}

/**
 * @returns {{
 *   channels: string[],
 *   sites: Array<{
 *     id: string, title: string, file: string, note: string,
 *     rule: object, missingFile?: boolean,
 *     cells: Array<{channel: string, count: number, lines: number[], extraCount: number|null, extraLabel: string|null}>
 *   }>,
 *   findings: Array<{severity: 'error'|'duplicate'|'asymmetry', site: string, channel: string|null, file: string, message: string, lines: number[]}>
 * }}
 */
export function collectIpcChannelCensus(root = REPO_ROOT) {
  const channels = discoverChannels(root);
  const findings = [];
  const sites = [];

  for (const site of SITES) {
    const source = readStripped(root, site.file);
    const cells = [];
    const counts = [];

    for (const channel of channels) {
      if (source === null) {
        cells.push({ channel, count: 0, lines: [], extraCount: null, extraLabel: null });
        counts.push(0);
        continue;
      }
      const hits = findHits(source, site.probe(channel));
      const extraHits = site.extra ? findHits(source, site.extra(channel)) : null;
      cells.push({
        channel,
        count: hits.length,
        lines: hits.map((hit) => hit.line),
        extraCount: extraHits === null ? null : extraHits.length,
        extraLabel: site.extraLabel ?? null,
      });
      counts.push(hits.length);
    }

    if (source === null) {
      findings.push({
        severity: 'error',
        site: site.id,
        channel: null,
        file: site.file,
        message: `站点文件不存在：${site.file}`,
        lines: [],
      });
    }

    // ── consensus baseline (computed before per-channel judgement) ─────────
    let consensusValue = null;
    if (site.rule.kind === 'consensus' && counts.length > 0) {
      consensusValue = majorityProfile(counts).value;
    }

    for (const cell of cells) {
      const { channel, count, lines } = cell;
      if (site.rule.kind === 'exactly') {
        if (count < site.rule.value) {
          findings.push({
            severity: 'error', site: site.id, channel, file: site.file,
            message: `缺少站点（期望恰好 ${site.rule.value} 处，实为 ${count}）`, lines,
          });
        } else if (count > site.rule.value) {
          findings.push({
            severity: 'duplicate', site: site.id, channel, file: site.file,
            message: `重复 ${count - site.rule.value} 处（期望恰好 ${site.rule.value} 处）`, lines,
          });
        }
      } else if (site.rule.kind === 'min') {
        if (count < site.rule.value) {
          findings.push({
            severity: 'error', site: site.id, channel, file: site.file,
            message: `缺少站点（期望 ≥${site.rule.value} 处，实为 ${count}）`, lines,
          });
        }
      } else if (site.rule.kind === 'consensus') {
        if (count !== consensusValue) {
          findings.push({
            severity: 'asymmetry', site: site.id, channel, file: site.file,
            message: `与多数型态不一致：本通道 ${count} 处，多数通道 ${consensusValue} 处`, lines,
          });
        }
      }
    }

    sites.push({
      id: site.id,
      title: site.title,
      file: site.file,
      note: site.note,
      rule: site.rule,
      missingFile: source === null,
      consensusValue,
      cells,
    });
  }

  return { channels, sites, findings };
}

const SEVERITY_ORDER = { error: 0, asymmetry: 1, duplicate: 2 };

function ruleLabel(rule) {
  if (rule.kind === 'exactly') return `==${rule.value}`;
  if (rule.kind === 'min') return `>=${rule.value}`;
  return 'consensus';
}

function formatReport(report) {
  const { channels, sites, findings } = report;
  const width = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const out = [];
  out.push('');
  out.push('Worker IPC channel census (plan 610 §14 P0)');
  out.push(`${channels.length} channels × ${sites.length} sites`);
  out.push('');

  // ── per-site matrix ──────────────────────────────────────────────────────
  for (const site of sites) {
    const baseline = site.consensusValue === null || site.consensusValue === undefined
      ? ''
      : `  (多数型态 ${site.consensusValue})`;
    out.push(`${site.id}  [规则 ${ruleLabel(site.rule)}]${baseline}`);
    out.push(`  ${site.file}`);
    for (const cell of site.cells) {
      const mark = cell.count === 0 ? '·' : String(cell.count);
      const lines = cell.lines.length > 0 ? `  [${cell.lines.join(',')}]` : '';
      const extra = cell.extraCount === null
        ? ''
        : `   ${cell.extraLabel}=${cell.extraCount}`;
      out.push(`    ${cell.channel.padEnd(width)}  ${mark.padStart(3)}${lines}${extra}`);
    }
    out.push('');
  }

  // ── findings ─────────────────────────────────────────────────────────────
  if (findings.length === 0) {
    out.push('未发现偏差：每个通道在每个站点都满足其规则。');
  } else {
    const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const tally = { error: 0, asymmetry: 0, duplicate: 0 };
    for (const finding of sorted) tally[finding.severity] += 1;
    out.push(`偏差 ${findings.length} 条（error ${tally.error} / asymmetry ${tally.asymmetry} / duplicate ${tally.duplicate}）`);
    out.push('');
    for (const finding of sorted) {
      const label = finding.severity === 'error' ? 'ERROR'
        : finding.severity === 'asymmetry' ? 'ASYM ' : 'DUP  ';
      const where = finding.channel === null ? '' : `${finding.channel} — `;
      const lines = finding.lines.length > 0 ? ` [${finding.lines.join(',')}]` : '';
      out.push(`  ${label} ${finding.site}`);
      out.push(`        ${where}${finding.message}`);
      out.push(`        ${finding.file}${lines}`);
    }
  }

  out.push('');
  out.push('规则说明：error=站点缺失（通道会在运行期静默超时）；asymmetry=与多数型态不一致（必须显式立项或显式豁免）；duplicate=同一条件多份复制（正确性无碍，结构债）。');
  return out.join('\n');
}

function parseArgs(args) {
  const options = { strict: false, json: false, root: REPO_ROOT };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root' && args[index + 1]) {
      options.root = path.resolve(args[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: node scripts/architecture/ipc-channel-census.mjs [--strict] [--json] [--root <repo>]\n`);
    process.exitCode = 2;
    return;
  }

  const report = collectIpcChannelCensus(options.root);
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatReport(report)}\n`);

  if (options.strict) {
    const blocking = report.findings.filter((finding) => finding.severity !== 'duplicate');
    if (blocking.length > 0) {
      process.stderr.write(`\nIPC channel census failed: ${blocking.length} blocking finding(s) (error/asymmetry).\n`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
