import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);

interface PlanEntry {
  id: number | null;
  slug: string;
  title: string;
  status: string;
  file: string;
  tags?: string[];
  priority?: string;
  updated?: string;
  created?: string;
}

interface PlansCore {
  resolveProjectsRoot(): string;
  parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string };
  buildIndex(projectsRoot: string, projectId: string): { projectId: string; plans: PlanEntry[] };
  planStatus(input: Record<string, unknown>): { projectId: string; plans: PlanEntry[] };
  planSearch(input: Record<string, unknown>): { results: Array<Record<string, unknown>> };
  planComplete(input: Record<string, unknown>): { ok: boolean; newFile: string };
  PlansError: new (message: string, code: string) => Error & { code: string };
}

// The tools ship as plain CommonJS (unbundled builtin plugin), so the
// tests exercise the exact file that node will load at runtime.
const core = requireCjs(
  '../../src/plugins/builtin/plans/server/plans-core.cjs'
) as unknown as PlansCore;
const server = requireCjs(
  '../../src/plugins/builtin/plans/server/plans-server.cjs'
) as unknown as {
  handleMessage(message: unknown): { id?: unknown; result?: Record<string, unknown>; error?: unknown } | null;
  TOOLS: Array<{ name: string }>;
};

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const PLAN_A = `---
id: 525
title: Project entity and plans directory
priority: P1
status: active
tags: [project, plans]
created: 2026-09-12
updated: 2026-09-13
---

# Body
- [ ] 1.1 something
`;

const PLAN_B = `---
id: 530
title: Search tooling
status: active
tags: [search]
created: 2026-09-13
updated: 2026-09-13
---

body b
`;

const PLAN_DONE = `---
id: 510
title: Old finished plan
status: done
created: 2026-09-01
updated: 2026-09-02
---

done body
`;

describe('plans-core storage layer (Plan 525 Phase 4)', () => {
  let projectsRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-tools-test-'));
    projectsRoot = path.join(dir, 'projects');
    cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };
  });

  afterEach(() => cleanup());

  function writePlan(
    projectId: string,
    bucket: 'active' | 'completed',
    fileName: string,
    content: string
  ): void {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`unsafe test projectId: ${projectId}`);
    if (!/^[\d-]+[a-z0-9-]*\.md$/.test(fileName)) throw new Error(`unsafe test fileName: ${fileName}`);
    const rootBoundary = path.resolve(projectsRoot) + path.sep;
    const dir = path.resolve(path.join(projectsRoot, projectId, 'plans', bucket));
    const target = path.resolve(dir, fileName);
    if (!dir.startsWith(rootBoundary) || !target.startsWith(dir + path.sep)) {
      throw new Error('test fixture escaped the temp projects root');
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }

  function readIndexFile(projectId: string): string {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`unsafe test projectId: ${projectId}`);
    const rootBoundary = path.resolve(projectsRoot) + path.sep;
    const target = path.resolve(path.join(projectsRoot, projectId, 'plans', 'index.json'));
    if (!target.startsWith(rootBoundary)) throw new Error('test fixture escaped the temp projects root');
    return fs.readFileSync(target, 'utf8');
  }

  it('1. buildIndex scans both buckets, parses frontmatter, and writes index.json', () => {
    writePlan('proj-a', 'active', '525-project-entity.md', PLAN_A);
    writePlan('proj-a', 'active', '530-search-tooling.md', PLAN_B);
    writePlan('proj-a', 'completed', '510-old-finished.md', PLAN_DONE);

    const index = core.buildIndex(projectsRoot, 'proj-a');
    expect(index.projectId).toBe('proj-a');
    expect(index.plans.map((p) => p.id)).toEqual([510, 525, 530]);
    expect(index.plans[0]).toMatchObject({
      id: 510,
      slug: 'old-finished',
      status: 'done',
      file: 'completed/510-old-finished.md',
    });
    expect(index.plans[1]).toMatchObject({
      id: 525,
      title: 'Project entity and plans directory',
      status: 'active',
      priority: 'P1',
      tags: ['project', 'plans'],
    });

    expect(JSON.parse(readIndexFile('proj-a'))).toEqual(index);
  });

  it('2. plan_status defaults to active and "all" includes completed', () => {
    writePlan('proj-a', 'active', '525-project-entity.md', PLAN_A);
    writePlan('proj-a', 'completed', '510-old-finished.md', PLAN_DONE);

    const active = core.planStatus({ projectsRoot, projectId: 'proj-a' });
    expect(active.plans.map((p) => p.id)).toEqual([525]);

    const all = core.planStatus({ projectsRoot, projectId: 'proj-a', status: 'all' });
    expect(all.plans.map((p) => p.id)).toEqual([510, 525]);
  });

  it('3. plan_search finds matches across projects and honors project scope', () => {
    writePlan('proj-a', 'active', '525-project-entity.md', PLAN_A);
    writePlan('proj-b', 'active', '530-search-tooling.md', PLAN_B);

    const all = core.planSearch({ projectsRoot, query: 'plan' });
    expect(all.results.map((r) => r.projectId)).toEqual(['proj-a']);

    const cross = core.planSearch({ projectsRoot, query: 'tooling' });
    expect(cross.results.map((r) => r.projectId)).toEqual(['proj-b']);
    expect(cross.results[0]).toMatchObject({
      id: 530,
      slug: 'search-tooling',
      file: 'active/530-search-tooling.md',
    });

    const scoped = core.planSearch({ projectsRoot, query: 'tooling', scope: 'project', projectId: 'proj-a' });
    expect(scoped.results).toEqual([]);
  });

  it('4. plan_complete flips status, moves the file, and refreshes the index', () => {
    writePlan('proj-a', 'active', '525-project-entity.md', PLAN_A);

    const result = core.planComplete({ projectsRoot, projectId: 'proj-a', planId: 525 });
    expect(result.ok).toBe(true);
    expect(result.newFile).toBe(
      path.resolve(path.join(projectsRoot, 'proj-a', 'plans', 'completed', '525-project-entity.md'))
    );

    const moved = fs.readFileSync(result.newFile, 'utf8');
    expect(moved).toMatch(/^status: done$/m);
    expect(
      fs.existsSync(path.resolve(path.join(projectsRoot, 'proj-a', 'plans', 'active', '525-project-entity.md')))
    ).toBe(false);

    const index = core.buildIndex(projectsRoot, 'proj-a');
    expect(index.plans[0]).toMatchObject({ id: 525, status: 'done', file: 'completed/525-project-entity.md' });
  });

  it('5. plan_complete rejects unknown plans, double completion, bad ids, and missing frontmatter', () => {
    writePlan('proj-a', 'active', '525-project-entity.md', PLAN_A);
    writePlan('proj-a', 'active', '999-no-frontmatter.md', 'just text, no fm');

    expect(() => core.planComplete({ projectsRoot, projectId: 'proj-a', planId: 404 })).toThrow(/not found/);

    core.planComplete({ projectsRoot, projectId: 'proj-a', planId: 525 });
    expect(() => core.planComplete({ projectsRoot, projectId: 'proj-a', planId: 525 })).toThrow(
      /already completed/
    );

    expect(() => core.planComplete({ projectsRoot, projectId: '../evil', planId: 1 })).toThrow(/projectId/);
    expect(() => core.planComplete({ projectsRoot, projectId: 'proj-a', planId: 'x' })).toThrow(/planId/);
    expect(() => core.planComplete({ projectsRoot, projectId: 'proj-a', planId: 999 })).toThrow(
      /no status frontmatter/
    );
  });

  it('6. a plan file created behind the server back (plain Write) is discovered on the next query', () => {
    core.planStatus({ projectsRoot, projectId: 'proj-a' }); // seeds an empty index
    writePlan('proj-a', 'active', '525-project-entity.md', PLAN_A);

    const status = core.planStatus({ projectsRoot, projectId: 'proj-a' });
    expect(status.plans.map((p) => p.id)).toEqual([525]);
  });
});

describe('plans-server MCP wire layer', () => {
  it('7. tools/list exposes exactly the three plan tools', () => {
    const response = server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['plan_status', 'plan_search', 'plan_complete']);
  });

  it('8. initialize echoes the requested protocol version and identifies the server', () => {
    const response = server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(response?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'duya-plans' },
    });
  });

  it('9. tools/call plan_status returns JSON text content; errors come back as isError results', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-wire-test-'));
    try {
      const projectsRoot = path.join(dir, 'projects');
      const plansDir = path.resolve(path.join(projectsRoot, 'proj-a', 'plans', 'active'));
      fs.mkdirSync(plansDir, { recursive: true });
      fs.writeFileSync(path.resolve(plansDir, '525-project-entity.md'), PLAN_A, 'utf8');

      const coreMutable = core as unknown as { resolveProjectsRoot: () => string };
      const origResolve = coreMutable.resolveProjectsRoot;
      coreMutable.resolveProjectsRoot = () => projectsRoot;
      try {
        const ok = server.handleMessage({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'plan_status', arguments: { projectId: 'proj-a' } },
        });
        const okResult = ok?.result as { isError?: boolean; content: Array<{ text: string }> };
        expect(okResult.isError).toBeUndefined();
        expect(JSON.parse(okResult.content[0].text)).toEqual({
          projectId: 'proj-a',
          plans: [expect.objectContaining({ id: 525 })],
        });

        const err = server.handleMessage({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'plan_status', arguments: { projectId: 'no/slash' } },
        });
        const errResult = err?.result as { isError: boolean; content: Array<{ text: string }> };
        expect(errResult.isError).toBe(true);
        expect(JSON.parse(errResult.content[0].text).code).toBe('invalid_project_id');
      } finally {
        coreMutable.resolveProjectsRoot = origResolve;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('10. notifications produce no response; unknown methods get a JSON-RPC error', () => {
    expect(server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const response = server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'no/such/method' });
    expect((response?.error as { code: number }).code).toBe(-32601);
  });
});
