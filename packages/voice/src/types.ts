/**
 * @duya/voice — shared contracts for the voice input pipeline.
 *
 * Process model (aligned with grok's dictation model):
 *   Renderer captures PCM → IPC → Main (VoiceService) → STT worker → interim/final text
 */

/** A single block of mono 16-bit PCM at 16 kHz. */
export type PcmChunk = Int16Array;

/** Public voice config surfaced to the renderer (sanitized, no secrets). */
export interface VoiceConfigDTO {
  enabled: boolean;
  engine: 'local' | 'cloud';
  endSilenceMs: number;
  noSpeechTimeoutMs: number;
  chunkMs: number;
  language: string;
  model: string;
  modelReady: boolean;
  modelSizeMb: number;
}

export interface ModelStatusDTO {
  model: string;
  ready: boolean;
  sizeMb: number;
  path?: string;
}

/** Result of an STT engine transcription pass. */
export type SttResult =
  | { done: false; text: string; isFinal: boolean } // interim / partial
  | { done: true; text: string }; // final

/** Discriminated union for STT engine errors. */
export type VoiceErrorCode =
  | 'no_speech'
  | 'permission_denied'
  | 'model_not_ready'
  | 'network'
  | 'internal';

export interface VoiceError {
  code: VoiceErrorCode;
  message: string;
}

/** Events emitted Main → Renderer. */
export interface VoiceEvents {
  interim: (d: { sessionId: string; text: string }) => void;
  final: (d: { sessionId: string; text: string }) => void;
  error: (d: { sessionId: string; code: VoiceErrorCode; message: string }) => void;
  cancelled: (d: { sessionId: string; reason: string }) => void;
}

/** Renderer-side hook state (mirrored in src/lib/voice/types.ts). */
export type VoiceStatus =
  | 'idle'
  | 'permission-pending'
  | 'recording'
  | 'transcribing'
  | 'error';

/** STT engine abstraction. `local` = whisper.cpp (default), `cloud` = OpenAI-compatible. */
export interface SttEngine {
  readonly kind: 'local' | 'cloud';
  /** Append a PCM chunk to the streaming buffer. Returns an interim if available. */
  push(chunk: PcmChunk): Promise<SttResult | null>;
  /** Finalize the current utterance and return the full transcription. */
  finalize(): Promise<SttResult>;
  /** Drop the current utterance without producing text. */
  reset(): void;
  /** True once the engine is ready to transcribe (model loaded). */
  readonly ready: boolean;
}

/** VoiceService facade used by the Electron Main process. */
export interface VoiceService {
  start(opts?: { sessionId?: string }): Promise<{ ok: boolean; error?: string }>;
  transcribeChunk(chunk: PcmChunk): Promise<{ ok: boolean }>;
  stop(): Promise<{ ok: boolean }>;
  cancel(): Promise<{ ok: boolean }>;
  getConfig(): VoiceConfigDTO;
  getModelStatus(): ModelStatusDTO;
  readonly events: VoiceEvents;
  dispose(): void;
}