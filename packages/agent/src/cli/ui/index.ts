/**
 * CLI UI Components
 *
 * Exports the terminal UI for the DUYA Agent CLI.
 *
 * ## Which of these construct a terminal
 *
 * `TUIApp` is the only export that does. Its constructor claims the terminal
 * (alternate screen, raw mode), so it MUST NOT be imported-and-constructed by a
 * non-interactive process. Call `shouldUseTui()` from `./tty.js` before
 * constructing it — measured on this repo's blessed 0.1.81, `blessed.screen()`
 * writes cursor and erase-screen sequences into a piped stdout.
 *
 * Everything else here is pure and safe to import anywhere, including tests.
 */

export { TUIApp, type TUIAppOptions } from './TUIApp.js';

export {
  TranscriptModel,
  readFrameContent,
  buildToolPreview,
  resetBlockIds,
  FRAME_TYPES,
  type Block,
  type BlockKind,
  type LegacyFrame,
  type ApplyResult,
  type AssistantBlock,
  type ThinkingBlock,
  type ToolBlock,
  type UserBlock,
  type ErrorBlock,
  type NoticeBlock,
  type PermissionRequest,
  type FrameType,
} from './blocks.js';

export {
  renderTranscript,
  renderOneBlock,
  escapeTags,
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
} from './transcript-view.js';

export {
  RenderScheduler,
  MIN_RENDER_INTERVAL_MS,
  type RenderSchedulerOptions,
  type TimerHandle,
} from './render-scheduler.js';

export { Pacer, type Gear, type PacerOptions, type PacingSignal } from './pacer.js';

export { DeltaBuffer, DEFAULT_STALE_MS, type DeltaBufferOptions } from './delta-buffer.js';

export {
  PasteBurstDetector,
  platformIdleTimeoutMs,
  WINDOWS_IDLE_TIMEOUT_MS,
  POSIX_IDLE_TIMEOUT_MS,
  type PasteBurstOptions,
} from './paste-burst.js';

export {
  InputEditor,
  pastePlaceholder,
  PASTE_PLACEHOLDER_THRESHOLD,
} from './editor.js';

export {
  visibleWidth,
  codePointWidth,
  wrapWithCursor,
  capLines,
  truncateToWidth,
  type WrappedText,
} from './width.js';

export {
  OverlayState,
  renderOverlay,
  type OverlayRequest,
  type PermissionDecision,
} from './overlay.js';

export {
  EscapeSafeWriter,
  findSafeCut,
  DEFAULT_WRITE_BUFFER_BYTES,
  type EscapeSafeWriterOptions,
} from './bounded-writer.js';

export { isInteractiveTty, shouldUseTui, type TtyStreams } from './tty.js';

export {
  promptText,
  promptSecret,
  promptConfirm,
  promptSelect,
  promptCheckbox,
  promptRadio,
  promptChecklist,
  type PromptOptions,
  type SelectOptions,
  type CheckboxOptions,
} from './prompts.js';
