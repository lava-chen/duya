// src/lib/voice/types.ts — Renderer-side mirror of the voice contract.
// Keep in sync with packages/voice/src/types.ts and electron/preload.ts VoiceAPI.

export type VoiceStatus =
  | 'idle'
  | 'permission-pending'
  | 'recording'
  | 'transcribing'
  | 'error';

export type VoiceErrorCode =
  | 'no_speech'
  | 'permission_denied'
  | 'model_not_ready'
  | 'network'
  | 'internal';

export type VoiceAutoStopReason = 'finalize' | 'no_speech';

export interface VoiceConfigDTO {
  enabled: boolean;
  inputDevice: string;
  engine: 'local' | 'cloud';
  endSilenceMs: number;
  noSpeechTimeoutMs: number;
  chunkMs: number;
  language: string;
  model: string;
  modelReady: boolean;
  modelSizeMb: number;
  cloudProvider: string;
  cloudModel: string;
}