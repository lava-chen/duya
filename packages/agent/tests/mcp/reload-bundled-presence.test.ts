// packages/agent/tests/mcp/reload-bundled-presence.test.ts
// Static test: assert that `reloadMCP()` in agent-process-entry.ts
// still merges `bundledConfigs` (from `resolveBundledMCPServerConfigs`)
// into the configs it passes to `agent.initMCPServers()`.
//
// This is a regression guard added in the Phase 1C amend. The audit
// found that the original Phase 1C commit (`d6f9ed8`) silently
// dropped the bundledConfigs line from reloadMCP, removing the
// literature fallback from the legacy reload path. We restore the
// line and pin it with a static check so a future refactor cannot
// silently re-introduce the regression.
//
// We read the source as text (not via dynamic import) so the test
// runs without the worker's heavy runtime boot. The check is purely
// textual: any pattern that drops `bundledConfigs` from the spread
// will fail.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ENTRY_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'process',
  'agent-process-entry.ts',
);

describe('reloadMCP — bundled MCP path is restored (Phase 1C amend regression guard)', () => {
  const src = readFileSync(ENTRY_PATH, 'utf-8');

  // Extract the reloadMCP function body. The function ends with a
  // `}` at column 0 followed by a blank line, and is followed by
  // either another top-level `function` / `async function` or a
  // section comment. We grab from `async function reloadMCP` to the
  // next top-level `^}` that is itself followed by either `\n\n` or
  // a known section comment.
  function extractReloadMCPBody(text: string): string | null {
    const start = text.indexOf('async function reloadMCP');
    if (start < 0) return null;
    // Walk forward; for each top-level `}` candidate, check whether
    // the rest of the file looks like the next section.
    const tail = text.slice(start);
    // The function body lives in a try/catch, so we can't rely on a
    // single closing brace. Instead, find the line that begins with
    // `^}` and is followed by either an empty line or a section
    // comment (e.g. `// ====...`).
    const lines = tail.split('\n');
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Track brace depth, ignoring lines that open with `//` and
      // braces inside template strings/comments (we don't need
      // perfect parsing here — only the outer braces).
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            // Reached the end of reloadMCP. Sanity-check the next
            // line to avoid matching inner closures.
            const next = lines[i + 1] ?? '';
            if (next.trim() === '' || next.startsWith('//') || next.startsWith('async function') || next.startsWith('function ')) {
              return lines.slice(0, i + 1).join('\n');
            }
          }
        }
      }
    }
    return null;
  }

  it('agent-process-entry.ts imports resolveBundledMCPServerConfigs from plugin-mcp-runtime', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*resolveBundledMCPServerConfigs[^}]*\}\s*from\s*['"]\.\/plugin-mcp-runtime\.js['"]/,
    );
  });

  it('reloadMCP body calls resolveBundledMCPServerConfigs and binds the result to bundledConfigs', () => {
    const body = extractReloadMCPBody(src);
    expect(body, 'reloadMCP function body not found').not.toBeNull();
    expect(body!).toMatch(/resolveBundledMCPServerConfigs\s*\(/);
    expect(body!).toMatch(/bundledConfigs\s*=/);
    // The spread must include bundledConfigs at the head of the
    // list, matching the pre-commit audit-baseline order:
    //   [...bundledConfigs, ...pluginConfigs, ...settingsResult.configs]
    expect(body!).toMatch(/\[\.\.\.bundledConfigs,\s*\.\.\.pluginConfigs,\s*\.\.\.settingsResult\.configs\]/);
  });

  it('reloadMCP log line includes the bundled count placeholder', () => {
    const body = extractReloadMCPBody(src);
    expect(body).not.toBeNull();
    // The log line is a template literal that contains three length
    // interpolations: bundledConfigs.length, pluginConfigs.length,
    // settingsResult.configs.length. We assert the bundled
    // interpolation is present and that "bundled" appears as a
    // label in the same string.
    expect(body!).toMatch(/bundledConfigs\.length/);
    expect(body!).toMatch(/Reloaded MCP servers:/);
    // Allow the "bundled" label to appear anywhere in the line.
    expect(body!).toMatch(/\bbundled\b/);
  });
});
