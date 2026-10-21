# @duya/ai Model List Lazy Loading (Plan 426 Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Eliminate eager loading of all 146 model entries and BUILTIN_CATALOG (24 providers × 20 fields) in `@duya/ai`, reducing agent worker cold-start source bytes by ~1.2 MB. Only the session's active provider's model list is loaded on demand.

**Architecture:** Split the monolithic `providers/index.ts` (which statically spreads 15 provider arrays into one `allProviderModels[]`) into a two-tier system: a lightweight `ProviderRegistry` class with a `getModels(provider)` lazy factory, and per-provider data files consumed only when that provider is first used. The existing `BUILTIN_CATALOG` (used only by frontend and electron main) remains unchanged since it is not in the agent worker bundle's critical path.

**Tech Stack:** `@duya/ai` workspace package, TypeScript, esbuild.

---

## Impact Assessment

| Metric | Before | After (estimated) |
|--------|--------|-----------------|
| Agent worker cold-start source bytes (@duya/ai subtree) | ~1.2 MB | ~150–300 KB |
| Models loaded per session | 146 (all) | 1 provider's array (typically 2–21) |
| Impact on electron main | None (catalog unchanged) | None |
| Impact on renderer | None (catalog unchanged) | None |
| Impact on CLI | None (CLI uses createAIClient lazy path) | None |

**Caller scope in agent worker bundle:**
- `agent-process-entry.ts` imports only `classifyError`, `APIErrorType`, `computeContextEstimate`, `normalizePromptTokens`, `ApiFormat`, `ModelCompat` types — **none of these pull the model list data**
- `DuyaAgent.ts` and other agent core modules do `findModelById` / `findModelCompat` via `@duya/ai`

**Most critical path:** `DuyaAgent.ts` → `findModelById` / `findModelCompat` → `allProviderModels` spread → 15 provider data files loaded at cold-start.

---

## File Map

### New files
- `packages/ai/src/providers/data/minimax.ts` — minimaxModels + minimaxCnModels arrays (12 entries)
- `packages/ai/src/providers/data/deepseek.ts` — deepseekModels (5 entries)
- `packages/ai/src/providers/data/qwen.ts` — qwenModels (21 entries)
- `packages/ai/src/providers/data/glm.ts` — glmModels + glmAnthropicModels (8 entries)
- `packages/ai/src/providers/data/kimi.ts` — kimiModels (7 entries)
- `packages/ai/src/providers/data/openai.ts` — openAIModels + openaiResponsesModels (5 entries)
- `packages/ai/src/providers/data/anthropic.ts` — anthropicModels (13 entries)
- `packages/ai/src/providers/data/openrouter.ts` — openrouterModels (52 entries, heaviest)
- `packages/ai/src/providers/data/ollama.ts` — ollamaModels (1 entry)
- `packages/ai/src/providers/data/xai.ts` — xaiModels (7 entries)
- `packages/ai/src/providers/data/stepfun.ts` — stepfunModels (2 entries)
- `packages/ai/src/providers/data/volcengine.ts` — volcengineModels (2 entries)
- `packages/ai/src/providers/data/bailian.ts` — bailianModels (4 entries)
- `packages/ai/src/providers/data/bedrock.ts` — bedrockModels (4 entries)
- `packages/ai/src/providers/data/google.ts` — googleModels (3 entries)
- `packages/ai/src/providers/provider-registry.ts` — `ProviderRegistry` class with lazy model loading

### Modified files
- `packages/ai/src/providers/index.ts` — re-export from ProviderRegistry instead of static spread array
- `packages/ai/src/models.ts` — `findModelById` / `findModelCompat` / `getSupportedThinkingLevels` delegate to ProviderRegistry
- `packages/ai/src/providers/models.ts` — `createModels()` uses ProviderRegistry

### Unchanged (not in agent worker critical path)
- `packages/ai/src/providers/catalog.ts` — BUILTIN_CATALOG, used only by frontend + electron main
- `packages/ai/src/providers/catalog-data.ts` — catalog entry data, unchanged
- `packages/ai/src/runtime-adapter.ts` — uses `createModels()` which will use ProviderRegistry
- `packages/ai/src/agent/DuyaAgent.ts` — already calls `findModelById` via @duya/ai, transparently benefits
- `packages/agent/src/agent/DuyaAgent.ts` — same, no change needed

---

## Tasks

### Task 1: Extract per-provider model data files

**Files:**
- Create: `packages/ai/src/providers/data/minimax.ts`
- Create: `packages/ai/src/providers/data/deepseek.ts`
- Create: `packages/ai/src/providers/data/qwen.ts`
- Create: `packages/ai/src/providers/data/glm.ts`
- Create: `packages/ai/src/providers/data/kimi.ts`
- Create: `packages/ai/src/providers/data/openai.ts`
- Create: `packages/ai/src/providers/data/anthropic.ts`
- Create: `packages/ai/src/providers/data/openrouter.ts`
- Create: `packages/ai/src/providers/data/ollama.ts`
- Create: `packages/ai/src/providers/data/xai.ts`
- Create: `packages/ai/src/providers/data/stepfun.ts`
- Create: `packages/ai/src/providers/data/volcengine.ts`
- Create: `packages/ai/src/providers/data/bailian.ts`
- Create: `packages/ai/src/providers/data/bedrock.ts`
- Create: `packages/ai/src/providers/data/google.ts`
- Modify: `packages/ai/src/providers/index.ts`

- [ ] **Step 1: Create data/minimax.ts**

```typescript
import type { Model } from '../../types.js';
export const minimaxModels: Model[] = [
  // ... existing entries from anthropic.models.ts etc.
];
export const minimaxCnModels: Model[] = [
  // ... existing entries
];
```

- [ ] **Step 2: Repeat for each provider file** (14 more data files)

- [ ] **Step 3: Rewrite providers/index.ts to use data files**

```typescript
// OLD (static spread, loads everything at import time):
export const allProviderModels: Model[] = [
  ...minimaxModels, ...deepseekModels, ...qwenModels, /* ... 15 spreads */,
];

// NEW (lazy, loads only when called):
export { minimaxModels } from './data/minimax.js';
export { minimaxCnModels } from './data/minimax.js';
// ... all re-exports from data/ files
```

- [ ] **Step 4: Verify build still passes**
Run: `npm run build:ai`
Expected: No TypeScript errors. Model types align.

- [ ] **Step 5: Commit**
```bash
git add packages/ai/src/providers/data/
git add packages/ai/src/providers/index.ts
git commit -m "feat(ai): split model data into per-provider files (plan 426b)"
```

---

### Task 2: Build ProviderRegistry with lazy loading

**Files:**
- Create: `packages/ai/src/providers/provider-registry.ts`
- Modify: `packages/ai/src/models.ts`

- [ ] **Step 1: Write ProviderRegistry class**

```typescript
// packages/ai/src/providers/provider-registry.ts
import type { Model } from '../types.js';

type ModelLoader = () => Promise<Model[]>;

const LOADERS: Record<string, ModelLoader> = {
  minimax:     () => import('./data/minimax.js').then(m => m.minimaxModels),
  minimax_cn:  () => import('./data/minimax.js').then(m => m.minimaxCnModels),
  deepseek:    () => import('./data/deepseek.js').then(m => m.deepseekModels),
  qwen:        () => import('./data/qwen.js').then(m => m.qwenModels),
  glm:         () => import('./data/glm.js').then(m => m.glmModels),
  glm_anthropic: () => import('./data/glm.js').then(m => m.glmAnthropicModels),
  kimi:        () => import('./data/kimi.js').then(m => m.kimiModels),
  openai:      () => import('./data/openai.js').then(m => m.openAIModels),
  openai_responses: () => import('./data/openai.js').then(m => m.openaiResponsesModels),
  anthropic:   () => import('./data/anthropic.js').then(m => m.anthropicModels),
  openrouter:  () => import('./data/openrouter.js').then(m => m.openrouterModels),
  ollama:      () => import('./data/ollama.js').then(m => m.ollamaModels),
  xai:         () => import('./data/xai.js').then(m => m.xaiModels),
  stepfun:     () => import('./data/stepfun.js').then(m => m.stepfunModels),
  volcengine:  () => import('./data/volcengine.js').then(m => m.volcengineModels),
  bailian:     () => import('./data/bailian.js').then(m => m.bailianModels),
  bedrock:     () => import('./data/bedrock.js').then(m => m.bedrockModels),
  google:      () => import('./data/google.js').then(m => m.googleModels),
};

const cache: Record<string, Model[]> = {};
const pending: Record<string, Promise<Model[]>> = {};

export const providerRegistry = {
  async getModels(provider: string): Promise<Model[]> {
    if (cache[provider]) return cache[provider];
    if (pending[provider]) return pending[provider];
    const loader = LOADERS[provider];
    if (!loader) return [];
    pending[provider] = loader().then(m => { cache[provider] = m; delete pending[provider]; return m; });
    return pending[provider];
  },

  async getAllModels(): Promise<Model[]> {
    const results = await Promise.all(Object.keys(LOADERS).map(k => this.getModels(k)));
    return results.flat();
  },
};
```

- [ ] **Step 2: Run build to verify types compile**
Run: `npm run build:ai`
Expected: PASS

- [ ] **Step 3: Commit**
```bash
git add packages/ai/src/providers/provider-registry.ts
git commit -m "feat(ai): add ProviderRegistry with per-provider lazy model loading (plan 426b)"
```

---

### Task 3: Migrate findModelById / findModelCompat to use ProviderRegistry

**Files:**
- Modify: `packages/ai/src/models.ts`

- [ ] **Step 1: Read current models.ts implementation**

Locate `findModelById`, `findModelCompat`, `getSupportedThinkingLevels`, `getEffortOptionsForModel`, `getEffortOptionsForCapability`.

- [ ] **Step 2: Rewrite to use providerRegistry**

Key pattern — replace static array filter with async registry lookup:

```typescript
// OLD:
export function findModelById(id: string): Model | undefined {
  return allProviderModels.find(m => m.id === id);
}

// NEW:
let _allModelsCache: Model[] | null = null;

export async function findModelById(id: string): Promise<Model | undefined> {
  if (!_allModelsCache) _allModelsCache = await providerRegistry.getAllModels();
  return _allModelsCache.find(m => m.id === id);
}

// Synchronous stub for callers that need sync (wrap at call site with await):
export function findModelByIdSync(id: string): Model | undefined {
  return _allModelsCache?.find(m => m.id === id);
}
```

**Important:** `DuyaAgent.ts` and all agent worker callers must `await` the result. Add a comment documenting the async requirement.

- [ ] **Step 3: Verify all callers updated**

```bash
grep -rn "findModelById\|findModelCompat" packages/agent/src/
```

Ensure all call sites are updated to `await findModelById(...)`. Check:
- `packages/agent/src/agent/DuyaAgent.ts`
- `packages/agent/src/agent/session/model.ts`
- `packages/agent/src/agent/visual-analysis.ts`
- `packages/agent/src/tool/SessionSearchTool/SessionSearchTool.ts`

- [ ] **Step 4: Run build**
Run: `npm run build:ai && npm run bundle:agent`
Expected: No errors. agent bundle rebuilds.

- [ ] **Step 5: Run tests**
Run: `npm run test`
Expected: All pass.

- [ ] **Step 6: Commit**
```bash
git add packages/ai/src/models.ts
# add any caller changes
git commit -m "feat(ai): migrate findModelById/findModelCompat to async ProviderRegistry (plan 426b)"
```

---

### Task 4: Measure and verify lazy loading works

**Files:**
- Test: `packages/ai/src/providers/__tests__/provider-registry.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { providerRegistry } from '../provider-registry.js';

describe('providerRegistry', () => {
  it('loads only the requested provider on getModels(provider)', async () => {
    const m = await providerRegistry.getModels('anthropic');
    expect(m.length).toBeGreaterThan(0);
    expect(m[0]).toHaveProperty('id');
  });

  it('caches result — second call does not re-import', async () => {
    const first = await providerRegistry.getModels('openrouter');
    const second = await providerRegistry.getModels('openrouter');
    expect(second).toBe(first); // same reference
  });

  it('getAllModels aggregates all providers', async () => {
    const all = await providerRegistry.getAllModels();
    expect(all.length).toBeGreaterThan(140); // ~146 total
  });
});
```

- [ ] **Step 2: Run test**
Run: `npx vitest run packages/ai/src/providers/__tests__/provider-registry.test.ts`
Expected: PASS

- [ ] **Step 3: Measure bundle delta**

Re-run the esbuild measurement script to confirm:
- @duya/ai subtree in agent worker bundle drops from ~1.2 MB to <300 KB
- Only the active provider's data file (~5–50 KB) is loaded per session

Run: `node scripts/tmp-measure-agent.mjs` (reuse from plan 426 Phase 4)

- [ ] **Step 4: Commit**
```bash
git add packages/ai/src/providers/__tests__/provider-registry.test.ts
git commit -m "test(ai): add ProviderRegistry lazy-loading tests (plan 426b)"
```

---

### Task 5: Verify electron main and renderer unaffected

**Files:**
- None (read-only verification)

- [ ] **Step 1: Run typecheck for all packages**
Run: `npm run typecheck:all`
Expected: PASS

- [ ] **Step 2: Run electron build**
Run: `npm run build:electron`
Expected: SUCCESS. dist-electron/agent-server.js rebuilt.

- [ ] **Step 3: Commit if all clean**
```bash
git commit -m "chore: verify electron main and renderer unaffected by model lazy loading (plan 426b)"
```

---

## Rollback

If `findModelById` async migration causes issues in DuyaAgent or other callers:
1. Revert `models.ts` to use static `allProviderModels` (sync stub)
2. Keep per-provider data files — they are a clean refactor regardless
3. ProviderRegistry remains available for future use

---

## Dependencies

- Plan 426 Phase 1/2/3 must be complete (worker limits, idle reaper, config.toml integration) — this is Phase 4
- No breaking changes to `ProviderRuntimeConfig`, `RuntimeModelCapability`, or `@duya/ai` public API surface

## Notes

- `BUILTIN_CATALOG` (catalog.ts) is **NOT** migrated — it is only used by frontend and electron main, not by the agent worker. Migrating it would require concurrent changes in `src/lib/provider-presets.tsx` and `electron/services/providers/provider-store.ts`, which is out of scope for worker cold-start optimization.
- `allProviderModels` re-export from `providers/index.ts` is kept for backward compatibility with any code that imports it directly, but `models.ts` functions no longer use it synchronously.
