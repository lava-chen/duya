/**
 * Terminal UI primitives for the DUYA command-line client.
 *
 * This package owns terminal rendering and input behavior. The host injects
 * run events and completion candidates so the TUI has no Agent runtime imports.
 * Construct `TUIApp` only after `shouldUseTui()` confirms both streams are TTYs.
 */

export { TUIApp, type TUIAppOptions, type TuiChoice } from './TUIApp.js';
export {
  runProviderLogin,
  type ProviderLoginAction,
  type ProviderApiFactory,
  type ProviderRegistrationPreset,
} from './provider-login.js';

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
  stylesOf,
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
  type Styles,
} from './transcript-view.js';

export {
  CompletionController,
  type CompletionKey,
  type CompletionSources,
  type CompletionState,
} from './completion.js';

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
  isDestructiveRequest,
  type OverlayRequest,
  type OverlayView,
  type PermissionDecision,
} from './overlay.js';

export {
  REBINDABLE_ACTIONS,
  applyKeyOverrides,
  loadKeyOverrides,
  normalizeChord,
  parseKeyConfigToml,
  toBlessedKeys,
} from './keymap.js';

export {
  EscapeSafeWriter,
  findSafeCut,
  DEFAULT_WRITE_BUFFER_BYTES,
  type EscapeSafeWriterOptions,
} from './bounded-writer.js';

export { isInteractiveTty, shouldUseTui, type TtyStreams } from './tty.js';

export {
  DARK_THEME_TAGS,
  LIGHT_THEME_TAGS,
  resolveThemeName,
  themeFor,
  defaultTheme,
  type ThemeName,
  type ThemeToken,
  type ThemeTags,
} from './theme.js';

export { WindowManager, type WindowSpec, type WindowItem } from './window.js';

export {
  splitStreamCommit,
  type StreamCommit,
} from './stream-commit.js';

export { ACTION_DEFS, helpGroups, keysColumn, type ActionDef } from './actions.js';
