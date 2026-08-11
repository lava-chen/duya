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
  type ResolvedVoiceConfig,
  detectWhisperBinary,
  checkModel,
  collectEnvReport,
  modelPath,
  modelRoot,
  ModelManager,
  Vad,
  type VoiceConfigDTO,
  type ModelStatusDTO,
  type VoiceErrorCode,
} from '@duya/voice';
import { SttWorker, type SttWorkerInitPayload } from './stt-worker';
import { getConfigStore } from '../../config/store-instance';
import { resolveConfigRoot } from '../../config/compass';
import { getProviderStore } from '../providers/provider-store-electron';
import { getLogger, LogComponent } from '../../logging/logger';

export type VoiceEmitChannel =
  | 'voice:interim'
  | 'voice:final'
  | 'voice:error'
  | 'voice:cancelled'
  | 'voice:auto-stop';

export interface VoiceServiceOptions {
  /** Push an event to the renderer (wired to webContents.send by the handler). */
  emit: (channel: VoiceEmitChannel, payload: unknown) => void;
}

export class VoiceService {
  private readonly opts: VoiceServiceOptions;
  private worker: SttWorker | null = null;
  private readonly vad: Vad;
  private readonly logger = getLogger();
  private readonly userDataRoot = resolveConfigRoot();

  constructor(opts: VoiceServiceOptions) {
    this.opts = opts;
    const cfg = this.resolvedConfig();
    this.vad = new Vad({
      endSilenceBlocks: Math.max(1, Math.round(cfg.endSilenceMs / cfg.chunkMs)),
      noSpeechBlocks: Math.max(1, Math.round(cfg.noSpeechTimeoutMs / cfg.chunkMs)),
    });
  }

  private resolvedConfig() {
    const raw = getConfigStore().getByPath('voice');
    return resolveVoiceConfig(raw as Parameters<typeof resolveVoiceConfig>[0]);
  }

  async start(opts?: { sessionId?: string }): Promise<{ ok: boolean; error?: string; message?: string }> {
    const cfg = this.resolvedConfig();
    if (!cfg.enabled) {
      return { ok: false, error: 'voice_disabled' };
    }

    if (cfg.engine === 'cloud') {
      return this.startCloud(cfg, opts?.sessionId);
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

    return this.launchWorker(
      'local',
      { binaryPath: binary.path, modelPath: modelFile, language: cfg.language },
      opts?.sessionId,
    );
  }

  /**
   * Cloud track: resolve the provider (explicit `voice.stt.cloud.provider`,
   * else the default provider), then base_url / api key / model from the
   * single-source provider config. Falls back to the default provider when
   * the configured one is missing.
   */
  private startCloud(
    cfg: ResolvedVoiceConfig,
    sessionId?: string,
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    const providerStore = getProviderStore();
    const provider =
      (cfg.cloud.provider ? providerStore.getLlmProvider(cfg.cloud.provider) : undefined) ??
      providerStore.getDefaultLlmProvider();
    const baseUrl = (cfg.cloud.baseUrl || provider?.endpoints.baseUrl || '').replace(/\/+$/, '');
    const apiKey = provider?.auth?.apiKey || '';
    if (!baseUrl || !apiKey) {
      return Promise.resolve({
        ok: false,
        error: 'cloud_engine_not_ready',
        message: 'cloud provider base_url / api key missing',
      });
    }
    return this.launchWorker('cloud', { baseUrl, apiKey, model: cfg.cloud.size }, sessionId);
  }

  /** Spawn the isolated STT worker and wait for the engine to report ready. */
  private async launchWorker(
    kind: 'local' | 'cloud',
    payload: SttWorkerInitPayload,
    sessionId?: string,
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    try {
      const worker = new SttWorker({
        onInterim: (text) => this.opts.emit('voice:interim', { sessionId, text }),
        onFinal: (text) => this.opts.emit('voice:final', { sessionId, text }),
        onError: (message, code) =>
          this.opts.emit('voice:error', {
            sessionId,
            code: normalizeErrorCode(code ?? 'internal'),
            message,
          }),
      });
      await worker.spawn();
      const ready = await worker.init({ ...payload, kind });
      if (!ready) {
        worker.dispose();
        return { ok: false, error: 'model_not_ready', message: 'worker init reported not ready' };
      }
      this.worker = worker;
      this.vad.reset();
      this.logger.info('Voice STT ready', { engine: kind }, LogComponent.Voice);
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
      const vadState = this.vad.push(chunk);
      if (vadState.kind === 'finalize') {
        this.autoFinalize(worker, chunk);
        return { ok: true };
      }
      if (vadState.kind === 'no_speech') {
        this.autoCancelNoSpeech(worker);
        return { ok: true };
      }
      worker.push(chunk);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Tail silence reached: finalize the current utterance and notify the
   * renderer that transcription auto-stopped. Synchronous on purpose so the
   * chunk pipeline stays { ok: boolean }.
   */
  private autoFinalize(worker: SttWorker, chunk: Int16Array): void {
    worker.finalize();
    this.opts.emit('voice:auto-stop', { reason: 'finalize' });
    worker.push(chunk);
  }

  /**
   * No speech for too long: cancel the utterance, reset VAD, and notify the
   * renderer. Synchronous on purpose (worker.reset() is sync).
   */
  private autoCancelNoSpeech(worker: SttWorker): void {
    worker.reset();
    this.vad.reset();
    this.opts.emit('voice:auto-stop', { reason: 'no_speech' });
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
    this.vad.reset();
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
      modelReady: cfg.engine === 'cloud' ? this.cloudReady() : modelStatus.ready,
      modelSizeMb: modelStatus.sizeMb,
    };
  }

  getModelStatus(): ModelStatusDTO {
    return this.modelStatus();
  }

  /** List all known local models with their readiness/size (for the picker). */
  getModelList(): ModelStatusDTO[] {
    return new ModelManager({ rootDir: modelRoot(this.userDataRoot) }).listModels();
  }

  /** First-use guidance report (whisper binary / model / install steps). */
  envReport() {
    return collectEnvReport();
  }

  private modelStatus(): ModelStatusDTO {
    const cfg = this.resolvedConfig();
    return checkModel(modelPath(this.userDataRoot, cfg.model));
  }

  /** True when the cloud track has a usable provider (base_url + api key). */
  private cloudReady(): boolean {
    const cfg = this.resolvedConfig();
    const providerStore = getProviderStore();
    const provider =
      (cfg.cloud.provider ? providerStore.getLlmProvider(cfg.cloud.provider) : undefined) ??
      providerStore.getDefaultLlmProvider();
    return !!(cfg.cloud.baseUrl || provider?.endpoints.baseUrl) && !!provider?.auth?.apiKey;
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