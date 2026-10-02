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
  runtimeBinDir,
  ModelManager,
  RuntimeManager,
  testCloudTranscription,
  Vad,
  type VoiceConfigDTO,
  type ModelStatusDTO,
  type ModelDownloadProgress,
  type RuntimeProgress,
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
  | 'voice:auto-stop'
  | 'voice:download-progress';

export interface VoiceServiceOptions {
  /** Push an event to the renderer (wired to webContents.send by the handler). */
  emit: (channel: VoiceEmitChannel, payload: unknown) => void;
}

export class VoiceService {
  private readonly opts: VoiceServiceOptions;
  private worker: SttWorker | null = null;
  private vad: Vad | null = null;
  private readonly logger = getLogger();
  private readonly userDataRoot = resolveConfigRoot();

  constructor(opts: VoiceServiceOptions) {
    this.opts = opts;
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

    // Local whisper.cpp path: explicit config path → managed runtime dir →
    // PATH → common candidates.
    const binary = detectWhisperBinary(
      process.platform,
      cfg.binaryPath,
      runtimeBinDir(this.userDataRoot),
    );
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
   * Cloud provider resolution with the full fallback chain: explicit
   * `voice.stt.cloud.provider` → default provider → first configured
   * provider (mirrors agent-communicator's getDefaultOrFirstLlmProvider) so
   * voice works out of the box whenever any provider exists.
   */
  private resolveCloudProvider(cfg: ResolvedVoiceConfig) {
    const providerStore = getProviderStore();
    const explicit = cfg.cloud.provider
      ? providerStore.getLlmProvider(cfg.cloud.provider)
      : undefined;
    return explicit ?? providerStore.getDefaultLlmProvider() ?? providerStore.listLlmProviders()[0];
  }

  private startCloud(
    cfg: ResolvedVoiceConfig,
    sessionId?: string,
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    const provider = this.resolveCloudProvider(cfg);
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
    // One worker per utterance: dispose any leftover worker from a previous
    // session so processes never accumulate.
    this.worker?.dispose();
    this.worker = null;

    const cfg = this.resolvedConfig();
    try {
      const worker = new SttWorker({
        onInterim: (text) => this.opts.emit('voice:interim', { sessionId, text }),
        onFinal: (text) => {
          this.opts.emit('voice:final', { sessionId, text });
          // The utterance is complete — tear the worker down so nothing leaks.
          if (this.worker === worker) this.worker = null;
          worker.dispose();
        },
        onError: (message, code) => {
          this.opts.emit('voice:error', {
            sessionId,
            code: normalizeErrorCode(code ?? 'internal'),
            message,
          });
          if (this.worker === worker) this.worker = null;
          worker.dispose();
        },
        onExit: () => {
          if (this.worker === worker) this.worker = null;
        },
      });
      await worker.spawn();
      const ready = await worker.init({ ...payload, kind });
      if (!ready) {
        worker.dispose();
        return { ok: false, error: 'model_not_ready', message: 'worker init reported not ready' };
      }
      this.worker = worker;
      this.vad = new Vad({
        endSilenceMs: cfg.endSilenceMs,
        noSpeechTimeoutMs: cfg.noSpeechTimeoutMs,
      });
      this.logger.info('Voice STT ready', { engine: kind }, LogComponent.Voice);
      return { ok: true };
    } catch (err) {
      this.logger.error('Failed to start voice STT', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Voice);
      return { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) };
    }
  }

  transcribeChunk(chunk: Int16Array): { ok: boolean } {
    const worker = this.worker;
    const vad = this.vad;
    if (!worker || !vad) return { ok: false };
    try {
      const vadState = vad.push(chunk);
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
   * renderer that transcription auto-stopped. The final text follows on the
   * `voice:final` event (which also disposes the worker). Synchronous on
   * purpose so the chunk pipeline stays { ok: boolean }.
   */
  private autoFinalize(worker: SttWorker, chunk: Int16Array): void {
    this.vad?.reset();
    worker.finalize();
    // Tail silence seeds the next utterance buffer; harmless because the
    // renderer stops capturing after the auto-stop event.
    worker.push(chunk);
    this.opts.emit('voice:auto-stop', { reason: 'finalize' });
  }

  /**
   * No speech for too long: cancel the utterance, reset VAD, and notify the
   * renderer. Synchronous on purpose (worker.reset() is sync).
   */
  private autoCancelNoSpeech(worker: SttWorker): void {
    this.vad?.reset();
    worker.reset();
    this.opts.emit('voice:auto-stop', { reason: 'no_speech' });
  }

  async stop(): Promise<{ ok: boolean }> {
    const worker = this.worker;
    if (!worker) return { ok: false };
    // Final text arrives on `voice:final`, which disposes the worker.
    worker.finalize();
    return { ok: true };
  }

  async cancel(): Promise<{ ok: boolean }> {
    const worker = this.worker;
    if (!worker) return { ok: false };
    this.vad?.reset();
    worker.reset();
    if (this.worker === worker) this.worker = null;
    worker.dispose();
    this.opts.emit('voice:cancelled', { reason: 'user_cancelled' });
    return { ok: true };
  }

  getConfig(): VoiceConfigDTO {
    const cfg = this.resolvedConfig();
    const modelStatus = this.modelStatus();
    const binary = detectWhisperBinary(
      process.platform,
      cfg.binaryPath,
      runtimeBinDir(this.userDataRoot),
    );
    return {
      enabled: cfg.enabled,
      inputDevice: cfg.inputDevice,
      engine: cfg.engine,
      endSilenceMs: cfg.endSilenceMs,
      noSpeechTimeoutMs: cfg.noSpeechTimeoutMs,
      chunkMs: cfg.chunkMs,
      language: cfg.language,
      model: cfg.model,
      modelReady:
        cfg.engine === 'cloud' ? this.cloudReady() : modelStatus.ready && binary.found,
      modelSizeMb: modelStatus.sizeMb,
      cloudProvider: cfg.cloud.provider,
      cloudModel: cfg.cloud.size,
    };
  }

  getModelStatus(): ModelStatusDTO {
    return this.modelStatus();
  }

  /** List all known local models with their readiness/size (for the picker). */
  getModelList(): ModelStatusDTO[] {
    return new ModelManager({
      rootDir: modelRoot(this.userDataRoot),
      baseUrl: this.resolvedConfig().modelUrlBase,
    }).listModels();
  }

  /** First-use guidance report (whisper binary / model / install steps). */
  envReport() {
    const cfg = this.resolvedConfig();
    return collectEnvReport({
      explicitPath: cfg.binaryPath,
      managedBinDir: runtimeBinDir(this.userDataRoot),
      runtimeBaseUrl: cfg.runtimeUrlBase,
    });
  }

  /** Managed prebuilt-runtime status (for the one-click install card). */
  runtimeStatus() {
    const cfg = this.resolvedConfig();
    return new RuntimeManager({
      binDir: runtimeBinDir(this.userDataRoot),
      baseUrl: cfg.runtimeUrlBase,
    }).status();
  }

  /** One-click install: download + extract the prebuilt whisper.cpp CLI. */
  async installRuntime(): Promise<{ ok: boolean; message?: string; path?: string }> {
    const cfg = this.resolvedConfig();
    const manager = new RuntimeManager({
      binDir: runtimeBinDir(this.userDataRoot),
      baseUrl: cfg.runtimeUrlBase,
    });
    const progress = (p: RuntimeProgress) =>
      this.opts.emit('voice:download-progress', { target: 'runtime', ...p });
    try {
      const status = await manager.install(progress);
      return status.ready
        ? { ok: true, path: status.path }
        : { ok: false, message: status.message ?? 'runtime install failed' };
    } catch (err) {
      this.logger.error('Voice runtime install failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Voice);
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Download a ggml model into the managed models dir. */
  async downloadModel(model?: string): Promise<{ ok: boolean; message?: string }> {
    const cfg = this.resolvedConfig();
    const target = model?.trim() || cfg.model;
    const manager = new ModelManager({
      rootDir: modelRoot(this.userDataRoot),
      baseUrl: cfg.modelUrlBase,
    });
    const progress = (p: ModelDownloadProgress) =>
      this.opts.emit('voice:download-progress', { target: 'model', model: p.model, ...p });
    try {
      await manager.ensure(target, undefined, progress);
      return { ok: true };
    } catch (err) {
      this.logger.error('Voice model download failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Voice);
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Probe the configured cloud provider with a 0.2 s silent transcription. */
  async cloudTest(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const cfg = this.resolvedConfig();
    const provider = this.resolveCloudProvider(cfg);
    const baseUrl = (cfg.cloud.baseUrl || provider?.endpoints.baseUrl || '').replace(/\/+$/, '');
    const apiKey = provider?.auth?.apiKey || '';
    if (!baseUrl || !apiKey) {
      return { ok: false, latencyMs: 0, message: '未配置可用的 provider（base_url / API Key 缺失）' };
    }
    return testCloudTranscription({ baseUrl, apiKey, model: cfg.cloud.size });
  }

  private modelStatus(): ModelStatusDTO {
    const cfg = this.resolvedConfig();
    return checkModel(modelPath(this.userDataRoot, cfg.model));
  }

  /** True when the cloud track has a usable provider (base_url + api key). */
  private cloudReady(): boolean {
    const cfg = this.resolvedConfig();
    const provider = this.resolveCloudProvider(cfg);
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