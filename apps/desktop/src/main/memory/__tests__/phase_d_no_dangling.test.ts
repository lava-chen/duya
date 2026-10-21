import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// This file sits six levels below the repo root
// (apps/desktop/src/main/memory/__tests__), so every path that leaves the
// desktop app needs six `..`. ce9366c9 moved electron/ and src/ under
// apps/desktop and left these at the old depth, which resolved into
// apps/desktop/src/... instead. The `consolidator.ts` case failed silently:
// the wrong path did not exist either, so `expect(existsSync).toBe(false)`
// passed without ever checking the real file.
const REPO_ROOT = path.join(__dirname, '../../../../../..');

describe('Phase D retire — no dangling imports', () => {
  it('consolidator.ts is deleted', () => {
    const p = path.join(REPO_ROOT, 'packages/memory/src/consolidator.ts');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('memory-worker.ts no longer imports runConsolidator', () => {
    const p = path.join(__dirname, '../memory-worker.ts');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).not.toMatch(/import.*runConsolidator/);
    expect(content).not.toMatch(/from.*consolidator/);
  });

  it('reconcile.ts no longer imports Phase 2 renderers from projectionContent', () => {
    const p = path.join(REPO_ROOT, 'packages/memory/src/reconcile.ts');
    const content = fs.readFileSync(p, 'utf8');
    // renderRolloutSummaryFile MUST still be imported (Stage 1 keeps it).
    expect(content).toMatch(/renderRolloutSummaryFile/);
    // Phase 2 renderers MUST be gone.
    expect(content).not.toMatch(/renderUnifiedMemoryFile/);
    expect(content).not.toMatch(/renderMemorySummaryFile/);
    expect(content).not.toMatch(/renderPhase2WorkspaceDiff/);
    expect(content).not.toMatch(/renderPersonFile/);
    expect(content).not.toMatch(/renderAreaFile/);
    expect(content).not.toMatch(/renderPeopleIndexFile/);
    expect(content).not.toMatch(/renderAreasIndexFile/);
  });

  it('projectionContent.ts still exports renderRolloutSummaryFile', () => {
    const p = path.join(REPO_ROOT, 'packages/memory/src/projectionContent.ts');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toMatch(/export function renderRolloutSummaryFile/);
  });

  it('curation_publish_orchestrator.ts no longer calls rebuildMemoryEntriesFromFiles', () => {
    const p = path.join(__dirname, '../curation_publish_orchestrator.ts');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).not.toMatch(/rebuildMemoryEntriesFromFiles/);
    expect(content).not.toMatch(/memory_entries_rebuild/);
  });

  it('scripts/reconcile-memory-projections.mjs no longer imports runConsolidator', () => {
    const p = path.join(REPO_ROOT, 'scripts/reconcile-memory-projections.mjs');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).not.toMatch(/runConsolidator/);
    expect(content).not.toMatch(/consolidator\.js/);
  });
});