/**
 * @duya/voice — public barrel.
 *
 * Exposes the voice config resolution, VAD, STT engine factory, model
 * manager, and local whisper environment detection.
 */
export * from './types';
export * from './config';
export * from './vad';
export * from './env';
export * from './model-manager';
export { createSttEngine, isRetryableError } from './stt/engine';
export { LocalWhisperEngine, encodeWav } from './stt/local';
export { CloudSttEngine } from './stt/cloud';