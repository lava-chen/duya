/**
 * Drift test #10 — the type-first deviation is deliberate, and stays deliberate.
 *
 * Design source: 07-agent-protocol-spec.md §15 (#10). Decision: D7 in
 * `docs/architecture/10-reference-comparison.md`.
 *
 * ## What 07 §15 #10 asked for
 *
 * "Regenerate `schema/*.json` from the types during the test, diff against the
 * committed copy, fail on drift." That presupposes a schema-first package —
 * the source of truth is a schema, types are generated from it or validated
 * against it, and the committed JSON is a derived artifact that can rot.
 *
 * ## Why this package does not have one
 *
 * pi-protocol is schema-first: typebox is its only runtime dependency, schemas
 * are the source of truth, and the runtime validates every message against
 * them. That is a defensible design and it is what 07 §15 #10 was copied from.
 * It is the wrong design HERE, for one reason: pi is a single client and a
 * single server in one language, with an explicit README statement that it
 * makes no compatibility promise. Duya has four independently deployed hosts
 * (main process, renderer, subprocess agent, HTTP+SSE gateway) plus a
 * CLI, each versioned separately, each able to be one minor behind.
 *
 * Runtime validation against a committed schema would force every host to ship
 * the schema AND a validator, and would make an older host crash on a newer
 * runtime's added field — the exact failure 07 §13 forbids. So the source of
 * truth here is the TypeScript type, and forward compatibility is handled by
 * the loose-decode-then-strict-validate split in `codecs.ts`.
 *
 * ## What this test is for, then
 *
 * The failure mode a schema directory brings is not "the schema is stale". It
 * is "someone hand-wrote a `schema/*.json`, nothing generates it, nothing reads
 * it, and the repo now carries a second source of truth that looks
 * authoritative." That is the `xai-grok-sampling-types` shape in miniature:
 * a package whose documented purity is a lie because an unmaintained artifact
 * sits next to it.
 *
 * So this test does not check freshness — it checks ABSENCE, and turns absence
 * into something that has to be argued for. If a `schema/` directory appears,
 * this test fails and demands that the same commit add the generator that
 * produces it. A hand-written schema cannot land.
 *
 * If Duya ever does need a language-neutral wire description (a non-JS
 * consumer, a gRPC/protobuf bridge, a public SDK), this test is the place that
 * decision gets recorded — and the generator has to arrive with it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_DIR = join(PKG_ROOT, 'schema');

function listIfPresent(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
}

describe('drift #10: no ungenerated schema artifacts', () => {
  it('has no schema/ directory', () => {
    expect(
      listIfPresent(SCHEMA_DIR),
      [
        'A schema/ directory appeared. This package is type-first on purpose',
        '(10-reference-comparison.md D7): the TypeScript type is the single',
        'source of truth, and a committed JSON Schema would be a second one',
        'that nothing regenerates.',
        '',
        'If a language-neutral description is genuinely required, the same',
        'commit must add the generator that produces these files AND a test',
        'that diffs the generated output against the committed copy —',
        'otherwise the artifact rots silently and reads as authoritative.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('exports no schema-shaped surface from the public entry', () => {
    // A validator is the runtime half of schema-first. `assertSatisfies` is
    // deliberately capability negotiation, not message validation: it checks
    // the runtime's limits and version, never an individual event's shape.
    // A per-message `validate()` here would be the drift, so this test pins
    // the absence at the module level too.
    const barrel = join(PKG_ROOT, 'src', 'index.ts');
    const text = existsSync(barrel) ? readFileSync(barrel) : null;
    if (text === null) throw new Error(`cannot verify the barrel: ${barrel} is missing`);

    const schemaModules = ['./schema/', '/schema.js', './validate.js', './validators.js'];
    const offenders = schemaModules.filter((m) => text.includes(m));
    expect(offenders, 'a schema module was re-exported from the barrel').toEqual([]);
  });
});
