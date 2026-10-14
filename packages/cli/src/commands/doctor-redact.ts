/**
 * Redaction pipeline for `duya doctor --json`.
 *
 * ## Why the JSON view needs its own pipeline
 *
 * The human-readable report deliberately keeps absolute paths: the config
 * permission check tells the user to run `chmod 600 "<path>"`, and a hint you
 * cannot copy and run is a hint that does not help.
 *
 * The same report in `--json` is the artifact people paste into a bug report.
 * That is a different audience with a different risk profile, so it gets a
 * different renderer — not a filtered copy of the human one. This mirrors how
 * the reference implementation separates `redacted_json_report` from its
 * human output.
 *
 * ## What is redacted
 *
 * The user name and home layout. The detected home directory collapses to `~`;
 * any other user-home prefix collapses its user segment to `…`:
 *
 *   `C:\Users\lavachen\.duya\secrets.json`  →  `~/.duya\secrets.json`
 *   `C:\Other\.duya\secrets.json`            →  `C:\Users\…\.duya\secrets.json`
 *   `/home/lavachen/.duya/secrets.json`      →  `~/.duya/secrets.json`
 *
 * ## What is deliberately NOT redacted
 *
 * Secret VALUES. No check puts one in the output — they report that a key is
 * missing, never what it holds — so there is nothing to scrub. Adding a
 * high-entropy-string detector here would be speculative and would mangle
 * hashes, ids and URLs.
 *
 * URLs and CLI arguments. `--json` output includes things like `/v1/sessions`,
 * which looks like an absolute path but is a route. Blanket path-matching would
 * corrupt them; the rules above are anchored on a user-home prefix precisely so
 * that only the part that identifies a person is removed.
 *
 * ## Why it recurses into `details`
 *
 * `details` is a caller-supplied `Record<string, unknown>`. If redaction only
 * walked `message` and `hint`, the module header's promise that the report
 * carries no absolute paths would hold only until the first check author put a
 * path in a detail. Recursing makes the invariant enforced by the type of the
 * field rather than by the discipline of whoever fills it.
 */

import * as os from 'node:os';
import type { DoctorResult } from './doctor.js';

export interface RedactionOptions {
  /**
   * The absolute home directory to collapse. Defaults to `os.homedir()`; tests
   * pass an explicit value so they do not depend on the machine they run on.
   */
  readonly home?: string;
}

/**
 * Fallback patterns for a user-home prefix, matched at a token boundary rather
 * than at the start of the string.
 *
 * The boundary is what keeps this from firing inside a URL path or a flag, and
 * what lets it catch a path embedded in a sentence — `Run: chmod 600 "C:\…"`
 * — which is the only shape the permission check actually emits. The captured
 * user segment becomes `…` rather than `~` because, unlike the exact-home
 * replacement above, this rule has not confirmed which directory it is.
 */
const HOME_PATTERNS: readonly RegExp[] = [
  /(^|[\s"'(\[])([A-Za-z]:[\\/]Users[\\/])[^\\/"'\s)\]]+/gu,
  /(^|[\s"'(\[])([\\/]Users[\\/])[^\\/"'\s)\]]+/gu,
  /(^|[\s"'(\[])([\\/]home[\\/])[^\\/"'\s)\]]+/gu,
];

/**
 * Collapse every home-ish prefix in one string.
 *
 * The detected home directory is replaced first, because its exact separator
 * and casing are known and it is the common case; the generic patterns then
 * catch anything that escaped it (a path recorded elsewhere, a different
 * platform's layout).
 */
export function redactPathInText(text: string, home: string): string {
  let out = text;

  if (home !== '') {
    // Windows accepts either separator for the same path, and a message may
    // carry the form that does not match how it was built.
    for (const separator of ['\\', '/']) {
      const variant = home.split(/[\\/]/u).join(separator);
      if (variant === '') continue;
      out = out.split(variant).join('~');
    }
  }

  for (const pattern of HOME_PATTERNS) {
    out = out.replace(pattern, (_match, boundary: string, prefix: string) => `${boundary}${prefix}…`);
  }

  return out;
}

/** Redact a JSON value of unknown shape, recursively. */
function redactValue(value: unknown, home: string): unknown {
  if (typeof value === 'string') return redactPathInText(value, home);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, home));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactValue(entry, home);
    }
    return out;
  }
  return value;
}

/**
 * The JSON view of a doctor report, with home directories collapsed.
 *
 * The shape mirrors `DoctorResult` field for field. It is NOT indexed by check
 * id the way the reference implementation does — that would be a breaking change
 * for every consumer of `duya doctor --json`, and nothing here needs lookup
 * faster than a filter.
 */
export function redactDoctorJson(result: DoctorResult, options: RedactionOptions = {}): unknown {
  const home = options.home ?? os.homedir();
  return {
    schemaVersion: result.version,
    version: result.version,
    timestamp: result.timestamp,
    overallStatus: result.overallStatus,
    profile: result.profile,
    summary: result.summary,
    checks: result.checks.map((check) => ({
      id: redactPathInText(check.id, home),
      category: check.category,
      status: check.status,
      message: redactPathInText(check.message, home),
      ...(check.hint === undefined ? {} : { hint: redactPathInText(check.hint, home) }),
      ...(check.details === undefined
        ? {}
        : { details: redactValue(check.details, home) }),
    })),
  };
}