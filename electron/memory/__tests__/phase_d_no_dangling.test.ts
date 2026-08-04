import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Phase D retire — no dangling imports', () => {
  it('consolidator.ts is deleted', () => {
    const p = path.join(__dirname, '../../../packages/agent/src/memory-state/consolidator.ts');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('memory-worker.ts no longer imports runConsolidator', () => {
    const p = path.join(__dirname, '../memory-worker.ts');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).not.toMatch(/import.*runConsolidator/);
    expect(content).not.toMatch(/from.*consolidator/);
  });

  it('reconcile.ts no longer imports Phase 2 renderers from projectionContent', () => {
    const p = path.join(__dirname, '../../../packages/agent/src/memory-state/reconcile.ts');
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
    const p = path.join(__dirname, '../../../packages/agent/src/memory-state/projectionContent.ts');
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
    const p = path.join(__dirname, '../../../scripts/reconcile-memory-projections.mjs');
    const content = fs.readFileSync(p, 'utf8');
    expect(content).not.toMatch(/runConsolidator/);
    expect(content).not.toMatch(/consolidator\.js/);
  });
});