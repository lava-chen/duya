import fs from 'node:fs';

/**
 * Extract top-level field names from a `export interface X { ... }` block.
 * CRLF-safe and brace-counting, because the tracked files check out with CRLF
 * on Windows and a naive `line === '}'` never matches there.
 */
export function extractInterface(source, name) {
  const re = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`, 'g');
  const m = re.exec(source);
  if (!m) return null;

  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`unbalanced braces in interface ${name}`);

  const body = source.slice(start, i - 1);
  const fields = [];
  for (const raw of body.split(/\r?\n/)) {
    // Top-level only: one indent level inside an interface. The `readonly`
    // modifier is optional — worker-protocol.ts omits it, payloads.ts uses it,
    // and a pattern that requires it silently extracts nothing from the former.
    const m2 = /^ {2}(?:readonly\s+)?(\w+)(\??):/.exec(raw);
    if (m2) fields.push({ name: m2[1], optional: m2[2] === '?' });
  }
  return fields;
}

/** The `type: '...'` discriminant of an interface. */
export function extractDiscriminant(source, name) {
  const fields = extractInterface(source, name);
  if (!fields) return null;
  const m = new RegExp(`export\\s+interface\\s+${name}\\s*\\{[\\s\\S]*?type:\\s*'([^']+)'`).exec(source);
  return m ? m[1] : null;
}

if (process.argv[1] && process.argv[1].endsWith('extract-worker-fields.mjs')) {
  const W = 'packages/agent/src/process/worker-protocol.ts';
  const src = fs.readFileSync(W, 'utf8');
  for (const n of ['GoalUpdatedEvent', 'AgentModeChangedEvent', 'SubagentToolResultEvent']) {
    const f = extractInterface(src, n);
    console.log('  ' + n.padEnd(28) + (f ? f.map((x) => x.name + (x.optional ? '?' : '')).join(' ') : 'NOT FOUND'));
  }
  // Guard: a parser that silently extracts nothing would make every
  // downstream assertion vacuously true.
  if (!extractInterface(src, 'GoalUpdatedEvent')?.length) {
    console.error('EXTRACTION BROKEN — assertions would pass vacuously');
    process.exit(1);
  }
}
