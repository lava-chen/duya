/**
 * services/voice/index.ts — VoiceService facade (Electron Main).
 *
 * Thin shell over @duya/voice: resolves config from the single-source
 * ConfigStore, detects the local whisper environment, manages the isolated
 * STT worker lifecycle, and forwards interim/final/error events to the
 * renderer through the injected `emit` callback.
 */
import {
  resolveVoiceConfig,
  detectWhisperBinary,
  checkModel,
  collectEnvReport,
  modelPath,
  type VoiceConfigDTO,
  type ModelStatusDTO,
  type VoiceErrorCode,
} from '@duya/voice';
import { SttWorker, type SttWorkerInitPayload } from './stt-worker';
import { getConfigStore } from '../../config/store-instance';
import { resolveConfigRoot } from '../../config/compass';
import { getLogger, LogComponent } from '../../logging/logger';

export type VoiceEmitChannel = 'voice:interim' | 'voice:final' | 'voice:error' | 'voice:cancelled';

export interface VoiceServiceOptions {
  /** Push an event to the renderer (wired to webContents.send by the handler). */
  emit: (channel: VoiceEmitChannel, payload: unknown) => void;
}

export class VoiceService {
  private readonly opts: VoiceServiceOptions;
  private worker: SttWorker | null = null;
  private readonly logger = getLogger();
  private readonly userDataRoot = resolveConfigRoot();

  constructor(opts: VoiceServiceOptions) {
    this.opts = opts;
  }

  private resolvedConfig() {
    const raw = getConfigStore().getByPath('voice');
    return resolveVoiceConfig(raw as Parameters<typeof resolveVoiceConfig>[0]);
  }

  async start(opts?: { sessionId?: string }): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.resolvedConfig();
    if (!cfg.enabled) {
      return { ok: false, error: 'voice_disabled' };
    }

    if (cfg.engine === 'cloud') {
      return { ok: false, error: 'cloud_engine_not_ready' };
    }

    // Local whisper.cpp path.
    const binary = detectWhisperBinary();
    if (!binary.found || !binary.path) {
      return { ok: false, error: 'model_not_ready', message: 'whisper binary missing' };
    }
    const modelFile = modelPath(this.userDataRoot, cfg.model);
    const modelStatus = checkModel(modelFile);
    if (!modelStatus.ready) {
      return { ok: false, error: 'model_not_ready', message: `model missing: ${cfg.model}` };
    }

    try {
      const worker = new SttWorker({
        onInterim: (text) => this.opts.emit('voice:interim', { sessionId: opts.sessionId, text }),
        onFinal: (text) => this.opts.emit('voice:final', { sessionId: opts.sessionId, text }),
        onError: (message, code) =>
          this.opts.emit('voice:error', {
            sessionId: opts.sessionId,
            code: normalizeErrorCode(code ?? 'internal'),
            message,
          }),
      });
      await worker.spawn();
      const payload: SttWorkerInitPayload = {
        kind: 'local',
        binaryPath: binary.path,
        modelPath: modelFile,
        language: cfg.language,
      };
      const ready = await worker.init(payload);
      if (!ready) {
        worker.dispose();
        return { ok: false, error: 'model_not_ready', message: 'worker init reported not ready' };
      }
      this.worker = worker;
      this.logger.info('Voice STT ready', { model: cfg.model }, LogComponent.Voice);
      return { ok: true };
    } catch (err) {
      this.logger.error('Failed to start voice STT', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Voice);
      return { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) };
    }
  }

  transcribeChunk(chunk: Int16Array): { ok: boolean } {
    const worker = this.worker;
    if (!worker) return { ok: false };
    try {
      worker.push(chunk);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async stop(): Promise<{ ok: boolean }> {
    const worker = this.worker;
    if (!worker) return { ok: false };
    worker.finalize();
    return { ok: true };
  }

  async cancel(): Promise<{ ok: boolean }> {
    const worker = this.worker;
    if (!worker) return { ok: false };
    worker.reset();
    return { ok: true };
  }

  getConfig(): VoiceConfigDTO {
    const cfg = this.resolvedConfig();
    const modelStatus = this.modelStatus();
    return {
      enabled: cfg.enabled,
      engine: cfg.engine,
      endSilenceMs: cfg.endSilenceMs,
      noSpeechTimeoutMs: cfg.noSpeechTimeoutMs,
      chunkMs: cfg.chunkMs,
      language: cfg.language,
      model: cfg.model,
      modelReady: modelStatus.ready,
      modelSizeMb: modelStatus.sizeMb,
    };
  }

  getModelStatus(): ModelStatusDTO {
    return this.modelStatus();
  }

  /** First-use guidance report (whisper binary / model / install steps). */
  envReport() {
    return collectEnvReport();
  }

  private modelStatus(): ModelStatusDTO {
    const cfg = this.resolvedConfig();
    return checkModel(modelPath(this.userDataRoot, cfg.model));
  }

  dispose(): void {
    this.worker?.dispose();
    this.worker = null;
  }
}

function normalizeErrorCode(code: string): VoiceErrorCode {
  const allowed: VoiceErrorCode[] = ['no_speech', 'permission_denied', 'model_not_ready', 'network', 'internal'];
  return allowed.includes(code as VoiceErrorCode) ? (code as VoiceErrorCode) : 'internal';
}

export function createVoiceService(opts: VoiceServiceOptions): VoiceService {
  return new VoiceService(opts);
}