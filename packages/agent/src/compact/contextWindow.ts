/**
 * Context-window resolution for the compaction budget.
 *
 * Plan 552: the implementation moved to `@duya/ai` (`resolveContextWindow`)
 * so the renderer ring and the compaction budget share one precedence chain
 * (capability → catalog → 200K default). This module is a thin re-export
 * kept only so agent-internal import paths stay stable.
 */
export {
  resolveContextWindow as resolveCompactionContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  type ContextWindowSource as CompactionContextWindowSource,
  type ResolvedContextWindow as CompactionContextWindow,
} from '@duya/ai'
