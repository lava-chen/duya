/**
 * streaming-tool-input.ts
 *
 * The desktop's entry point for the streamed-tool-argument helpers.
 *
 * The implementation lives in `@duya/client-core` because the CLI TUI needs
 * the same helpers and only that package is a dependency of both clients. This
 * file re-exports it, so every desktop call site keeps working unchanged.
 */

export {
  extractPartialToolFields,
  countContentLines,
  computeLineChangeStat,
  createStreamingToolInputGateState,
  shouldMaterializeStreamingToolInput,
  markStreamingToolInputMaterialized,
  type LineChangeStat,
  type StreamingToolInputGateState,
} from '@duya/client-core';
