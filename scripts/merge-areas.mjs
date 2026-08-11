#!/usr/bin/env node
/**
 * merge-areas.mjs
 *
 * One-shot area consolidation (Plan 417 follow-up). Several canonical
 * files were split too finely — same topic, different sessions, so the
 * curator created a new slug each time instead of appending. This
 * merges them into one canonical file per topic.
 *
 * Merge policy:
 *   - new file: `# <topic>` + one `## Summary` (both summaries joined) +
 *     `## Details` with one `### <source-slug>` subsection per source.
 *   - sources are deleted after the merge (their git history survives;
 *     the memory root is git-backed before every curation run).
 *   - idempotent: if the target already exists the merge is skipped.
 *
 * Usage:
 *   node scripts/merge-areas.mjs --root <memory-root> [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || '', '.duya', 'memory');

// topic -> sources (in merge order). topic becomes the new slug.
const MERGES = {
  messagesession: [
    'messagesession-as-team-collaboration-substrate',
    'messagesession-tool-and-diagnostic-skill',
  ],
  'static-site-clone-and-visual-verification': [
    'bilibili-clone-visual-verify-protocol',
  ],
  'hydrology-coursework': [
    'crest-hydrology-model-study',
    'liangtian-station-design-flood-p001',
  ],
  'duya-architecture': [
    'duya-chat-pipeline-architecture',
    'duya-plugin-and-provider-architecture',
  ],
};

/** Split a canonical file into { title, summary, details }. */
function splitFile(body) {
  const lines = body.split('\n');
  let title = '';
  const summary = [];
  const details = [];
  let section = null; // 'summary' | 'details'
  for (const line of lines) {
    const t = /^#\s+(.+)/.exec(line);
    if (t) { title = t[1].trim(); continue; }
    if (/^##\s+summary\b/i.test(line)) { section = 'summary'; continue; }
    if (/^##\s+details\b/i.test(line)) { section = 'details'; continue; }
    if (/^##\s+/.test(line)) { section = null; continue; } // other H2
    if (section === 'summary') summary.push(line);
    else if (section === 'details') details.push(line);
  }
  return {
    title,
    summary: summary.join('\n').trim(),
    details: details.join('\n').trim(),
  };
}

function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : DEFAULT_ROOT;
  const dryRun = args.includes('--dry-run');

  const areasDir = path.join(root, 'global', 'areas');
  if (!existsSync(areasDir)) {
    console.error(`no areas dir at ${areasDir}`);
    process.exit(1);
  }

  for (const [topic, sources] of Object.entries(MERGES)) {
    const target = path.join(areasDir, `${topic}.md`);
    const targetExists = existsSync(target);

    const parts = [];
    for (const src of sources) {
      const p = path.join(areasDir, `${src}.md`);
      if (!existsSync(p)) {
        console.log(`SKIP ${topic}: missing source ${src}`);
        parts.length = 0;
        break;
      }
      parts.push({ src, body: readFileSync(p, 'utf8') });
    }
    if (parts.length === 0) continue;

    const parsed = parts.map(({ src, body }) => ({ src, ...splitFile(body) }));

    const title = topic.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    const summary = parsed.map((p) => p.summary).filter(Boolean).join('\n\n');
    const details = parsed
      .map((p) => p.details ? `### ${p.src}\n\n${p.details}` : '')
      .filter(Boolean)
      .join('\n\n');

    let merged;
    if (targetExists) {
      // Append-mode: keep the existing target file, add the new sources'
      // details as subsections (e.g. bilibili -> static-site clone).
      const existing = readFileSync(target, 'utf8');
      const existingTrimmed = existing.replace(/\s+$/, '');
      merged = existingTrimmed + '\n\n' + details + '\n';
    } else {
      merged = [
        `# ${title}`,
        '',
        '## Summary',
        '',
        summary,
        '',
        '## Details',
        '',
        details,
        '',
      ].join('\n');
    }

    if (dryRun) {
      console.log(`DRY-RUN ${topic}: would merge ${sources.join(' + ')} into ${topic}.md (${merged.length} chars)`);
      continue;
    }

    writeFileSync(target, merged, 'utf8');
    for (const src of sources) {
      const p = path.join(areasDir, `${src}.md`);
      if (existsSync(p)) unlinkSync(p);
    }
    console.log(`MERGED ${topic}: ${sources.join(' + ')} -> ${topic}.md (${merged.length} chars)`);
  }

  if (!dryRun) {
    console.log('\nRemaining area files:');
    for (const name of readdirSync(areasDir).sort()) {
      if (name.endsWith('.md') && name !== 'index.md') console.log(`  ${name}`);
    }
  }
}

try { main(); } catch (err) { console.error('merge-areas failed:', err); process.exit(1); }