/**
 * STT engine abstraction factory.
 *
 * `local` = whisper.cpp CLI subprocess (default). `cloud` = OpenAI-compatible
 * `/v1/audio/transcriptions` (optional, aligned with grok's dual-track STT but
 * NOT tied to any xAI-specific API).
 */
import type { SttEngine, VoiceError } from '../types';
import { LocalWhisperEngine, type LocalWhisperEngineOptions } from './local';
import { CloudSttEngine, type CloudSttEngineOptions } from './cloud';

export type { SttEngine };

export type SttEngineFactory = (opts: {
  kind: 'local' | 'cloud';
  local?: LocalWhisperEngineOptions;
  cloud?: CloudSttEngineOptions;
}) => SttEngine;

export function createSttEngine(opts: {
  kind: 'local' | 'cloud';
  local?: LocalWhisperEngineOptions;
  cloud?: CloudSttEngineOptions;
}): SttEngine {
  if (opts.kind === 'cloud') {
    return new CloudSttEngine(opts.cloud ?? {});
  }
  return new LocalWhisperEngine(opts.local ?? {});
}

export function isRetryableError(code: VoiceError['code']): boolean {
  return code === 'network';
}