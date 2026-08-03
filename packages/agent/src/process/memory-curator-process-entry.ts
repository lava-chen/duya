/**
 * memory-curator-process-entry.ts — Phase 2 Curator Agent process entry.
 *
 * Registers exactly five root-bound file tools (read/write/edit/grep/glob),
 * each constructed with `allowedRoots` derived from a `--staging-root` argv.
 * The curator process literally cannot name live memory, the DB, or the
 * user home — every tool call is bounded to the staging workspace.
 *
 * What this entry does NOT register (design §7.3): bash / shell, MCP
 * servers, apps, plugin tools, subagent tools, skills, AGENTS.md, the
 * runtime memory prompt section, conductor / canvas / message-session
 * tools. These are absent by construction, not by permission.
 *
 * Design: docs/design-docs/2026-08-03-memory-phase2-curation-agent-design.md
 * §7 (Phase 2 Agent: toolset and sandboxing).
 */
import * as path from 'node:path';
import { ToolRegistry } from '../tool/registry.js';
import { ReadTool } from '../tool/ReadTool/ReadTool.js';
import { WriteTool } from '../tool/WriteTool/WriteTool.js';
import { EditTool } from '../tool/EditTool/EditTool.js';
import { GrepTool } from '../tool/GrepTool/GrepTool.js';
import { GlobTool } from '../tool/GlobTool/GlobTool.js';

/**
 * Construct a ToolRegistry containing exactly the five root-bound file
 * tools. Roots are derived from `stagingRoot` per design §7.2:
 *
 *   read  → memory, memory-config, stagingRoot (receipt), inputs
 *   write → memory, memory-config, stagingRoot (receipt)
 *   edit  → memory, memory-config
 *   grep  → memory, memory-config, inputs
 *   glob  → memory, memory-config, inputs
 *
 * `inputs/` is read-only for the curator (frozen rollout evidence) — it
 * is a root for read/grep/glob but NOT for write/edit. `stagingRoot`
 * itself is a write root only so the curator can emit `curation_receipt.json`
 * at the staging root; it must not write arbitrary files there.
 */
export function createCuratorTools(stagingRoot: string): ToolRegistry {
  if (!stagingRoot) {
    throw new Error('createCuratorTools: stagingRoot is required');
  }

  const memory = path.join(stagingRoot, 'memory');
  const memoryConfig = path.join(stagingRoot, 'memory-config');
  const inputs = path.join(stagingRoot, 'inputs');

  const readRoots = [memory, memoryConfig, stagingRoot, inputs];
  const writeRoots = [memory, memoryConfig, stagingRoot];
  const editRoots = [memory, memoryConfig];
  const searchRoots = [memory, memoryConfig, inputs];

  const readTool = new ReadTool({ allowedRoots: readRoots });
  const writeTool = new WriteTool({ allowedRoots: writeRoots });
  const editTool = new EditTool({ allowedRoots: editRoots });
  const grepTool = new GrepTool({ allowedRoots: searchRoots });
  const globTool = new GlobTool({ allowedRoots: searchRoots });

  const registry = new ToolRegistry();
  registry.register(readTool.toTool(), readTool, { exposeMode: 'always' });
  registry.register(writeTool.toTool(), writeTool, { exposeMode: 'always' });
  registry.register(editTool.toTool(), editTool, { exposeMode: 'always' });
  registry.register(grepTool.toTool(), grepTool, { exposeMode: 'always' });
  registry.register(globTool.toTool(), globTool, { exposeMode: 'always' });

  return registry;
}

/**
 * Read `--staging-root <path>` from an argv array and return the value.
 * Throws if the flag is missing, has no value, or the value is empty.
 *
 * Extracted from the process main so it is unit-testable without spawning
 * a real process. The curator process main (wired in a later plan) calls
 * this, then `createCuratorTools`.
 */
export function parseStagingRootFromArgv(argv: string[]): string {
  const idx = argv.indexOf('--staging-root');
  if (idx === -1) {
    throw new Error('memory-curator-process-entry: --staging-root <path> is required');
  }
  if (idx === argv.length - 1) {
    throw new Error('memory-curator-process-entry: --staging-root <path> is required (flag has no value)');
  }
  const value = argv[idx + 1];
  if (!value) {
    throw new Error('memory-curator-process-entry: --staging-root value is empty');
  }
  return value;
}