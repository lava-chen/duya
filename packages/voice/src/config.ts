/**
 * Raw voice config shape read from config.toml `[voice]` section.
 * All fields are optional so missing sections degrade to defaults.
 */
export interface VoiceConfig {
  enabled?: boolean;
  input_device?: string;
  stt?: {
    engine?: 'local' | 'cloud';
    end_silence_ms?: number;
    no_speech_timeout_ms?: number;
    chunk_ms?: number;
    language?: string;
    local?: {
      model?: string;
      /** Explicit whisper.cpp CLI path; overrides detection. */
      binary_path?: string;
      /** Mirror for ggml model downloads (default: huggingface.co). */
      model_url_base?: string;
      /** Mirror for prebuilt runtime downloads (default: github releases). */
      runtime_url_base?: string;
    };
    cloud?: {
      provider?: string;
      base_url?: string;
      size?: string;
    };
  };
}

export interface ResolvedVoiceConfig {
  enabled: boolean;
  /** Preferred input device id; empty = system default. */
  inputDevice: string;
  engine: 'local' | 'cloud';
  endSilenceMs: number;
  noSpeechTimeoutMs: number;
  chunkMs: number;
  language: string;
  model: string;
  /** Explicit whisper binary path ('' = auto-detect). */
  binaryPath: string;
  /** Model download mirror override ('' = huggingface.co). */
  modelUrlBase: string;
  /** Runtime download mirror override ('' = github releases). */
  runtimeUrlBase: string;
  cloud: {
    provider: string;
    baseUrl: string;
    size: string;
  };
}

/** Defaults expressed in ms (16 kHz mono PCM). */
export const DEFAULT_VOICE_CONFIG: ResolvedVoiceConfig = {
  enabled: false,
  inputDevice: '',
  engine: 'local',
  endSilenceMs: 900,
  noSpeechTimeoutMs: 4000,
  chunkMs: 200,
  language: 'zh',
  model: 'ggml-base.bin',
  binaryPath: '',
  modelUrlBase: '',
  runtimeUrlBase: '',
  cloud: {
    provider: '',
    baseUrl: '',
    size: 'whisper-1',
  },
};

/** Resolve a (possibly partial) raw voice config against defaults. */
export function resolveVoiceConfig(raw?: VoiceConfig): ResolvedVoiceConfig {
  const s = raw?.stt ?? {};
  return {
    enabled: raw?.enabled ?? DEFAULT_VOICE_CONFIG.enabled,
    inputDevice: raw?.input_device ?? DEFAULT_VOICE_CONFIG.inputDevice,
    engine: s.engine ?? DEFAULT_VOICE_CONFIG.engine,
    endSilenceMs: s.end_silence_ms ?? DEFAULT_VOICE_CONFIG.endSilenceMs,
    noSpeechTimeoutMs: s.no_speech_timeout_ms ?? DEFAULT_VOICE_CONFIG.noSpeechTimeoutMs,
    chunkMs: s.chunk_ms ?? DEFAULT_VOICE_CONFIG.chunkMs,
    language: s.language ?? DEFAULT_VOICE_CONFIG.language,
    model: s.local?.model ?? DEFAULT_VOICE_CONFIG.model,
    binaryPath: s.local?.binary_path ?? DEFAULT_VOICE_CONFIG.binaryPath,
    modelUrlBase: s.local?.model_url_base ?? DEFAULT_VOICE_CONFIG.modelUrlBase,
    runtimeUrlBase: s.local?.runtime_url_base ?? DEFAULT_VOICE_CONFIG.runtimeUrlBase,
    cloud: {
      provider: s.cloud?.provider ?? DEFAULT_VOICE_CONFIG.cloud.provider,
      baseUrl: s.cloud?.base_url ?? DEFAULT_VOICE_CONFIG.cloud.baseUrl,
      size: s.cloud?.size ?? DEFAULT_VOICE_CONFIG.cloud.size,
    },
  };
}

/** Model root directory lives under the DUYA user-data root. */
export function modelRoot(userDataRoot: string): string {
  return `${userDataRoot}/voice/models`;
}

export function modelPath(userDataRoot: string, model: string): string {
  return `${modelRoot(userDataRoot)}/${model}`;
}

/** Managed prebuilt-runtime directory (RuntimeManager install target). */
export function runtimeBinDir(userDataRoot: string): string {
  return `${userDataRoot}/voice/bin`;
}