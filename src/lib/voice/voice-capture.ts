// src/lib/voice/voice-capture.ts — mic → 16 kHz mono PCM16 → IPC to Main.
//
// Uses an AudioWorklet (loaded from an inline Blob URL) to downmix to mono
// and downsample to 16 kHz, emitting Int16 PCM blocks that are forwarded to
// the Main-process STT worker via `electronAPI.voice.transcribeChunk`.
// Blocks are batched to `blockSamples` (default 200 ms) so the IPC invoke
// rate stays ~5/s instead of one per render quantum (~375/s).
// No native dependencies run in the renderer.

const TARGET_RATE = 16000;
const DEFAULT_BLOCK_SAMPLES = 3200; // 200 ms @ 16 kHz

const WORKLET_SOURCE = `
class PcmDownmixProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetRate = sampleRate;
    this._ratio = 1;
    this._blockSamples = ${DEFAULT_BLOCK_SAMPLES};
    this._buffer = new Float32Array(0);
    this.port.onmessage = (e) => {
      if (e.data && e.data.targetRate) {
        this._targetRate = e.data.targetRate;
        this._ratio = sampleRate / this._targetRate;
      }
      if (e.data && e.data.blockSamples) {
        this._blockSamples = Math.max(1, e.data.blockSamples | 0);
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    let mono = input[0];
    if (input.length > 1) {
      mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i];
        mono[i] = s / input.length;
      }
    }
    const combined = new Float32Array(this._buffer.length + mono.length);
    combined.set(this._buffer);
    combined.set(mono, this._buffer.length);
    this._buffer = combined;

    // Emit only whole blocks of _blockSamples target-rate samples so the
    // renderer posts one bounded chunk per block instead of per quantum.
    const need = this._ratio * this._blockSamples;
    const blocks = Math.floor(this._buffer.length / need);
    if (blocks < 1) return true;
    const outLen = Math.min(blocks, 16) * this._blockSamples;
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.min(Math.floor(i * this._ratio), this._buffer.length - 1);
      const s = Math.max(-1, Math.min(1, this._buffer[idx]));
      out[i] = (s * 32767) | 0;
    }
    const consumed = Math.floor(outLen * this._ratio);
    this._buffer = this._buffer.slice(consumed);
    this.port.postMessage(out);
    return true;
  }
}
registerProcessor('pcm-downmix-processor', PcmDownmixProcessor);
`;

export interface VoiceCaptureCallbacks {
  onChunk: (chunk: Int16Array) => void;
  onError: (message: string) => void;
}

export interface VoiceCaptureStartOptions {
  /** Specific input device; empty/undefined = system default. */
  deviceId?: string;
  /** PCM samples per emitted block (default 3200 = 200 ms @ 16 kHz). */
  blockSamples?: number;
}

export interface VoiceCapture {
  start(opts?: VoiceCaptureStartOptions): Promise<{ ok: boolean; message?: string }>;
  stop(): void;
  readonly active: boolean;
}

/**
 * Build the MediaTrackConstraints for the microphone from a configured input
 * device. `deviceId === '' | undefined` maps to the system default (no exact
 * constraint), otherwise it pins the device with `{ exact }`. Extracted as a
 * pure function so the deviceId → constraints mapping is unit-testable.
 */
export function buildAudioConstraints(deviceId?: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

export class AudioWorkletVoiceCapture implements VoiceCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private _active = false;

  get active(): boolean {
    return this._active;
  }

  async start(opts?: VoiceCaptureStartOptions): Promise<{ ok: boolean; message?: string }> {
    if (this._active) return { ok: true };
    try {
      const audio = buildAudioConstraints(opts?.deviceId);
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      this.stream = stream;

      // Surface device loss (unplug / USB dropout) instead of streaming
      // silence until the user notices.
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          if (this._active) {
            this.onError?.('麦克风设备已断开，请检查设备连接后重试');
            this.stop();
          }
        };
      }

      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' })));
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-downmix-processor');
      node.port.start();
      node.port.onmessage = (e) => {
        if (e.data instanceof Int16Array) {
          this.onChunk?.(e.data);
        }
      };
      // Route through a zero-gain sink so the graph keeps pulling samples
      // without echoing the microphone back to the speakers.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);

      node.port.postMessage({
        targetRate: TARGET_RATE,
        blockSamples: opts?.blockSamples ?? DEFAULT_BLOCK_SAMPLES,
      });

      this.ctx = ctx;
      this.source = source;
      this.node = node;
      this._active = true;
      return { ok: true };
    } catch (err) {
      const message = describeMediaError(err);
      this.onError?.(message);
      this.stop();
      return { ok: false, message };
    }
  }

  stop(): void {
    this._active = false;
    try {
      this.node?.port.postMessage({});
    } catch { /* noop */ }
    try {
      this.node?.disconnect();
    } catch { /* noop */ }
    try {
      this.source?.disconnect();
    } catch { /* noop */ }
    try {
      this.stream?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
    } catch { /* noop */ }
    try {
      void this.ctx?.close();
    } catch { /* noop */ }
    this.node = null;
    this.source = null;
    this.ctx = null;
    this.stream = null;
  }

  private onChunk?: (chunk: Int16Array) => void;
  private onError?: (message: string) => void;

  setCallbacks(cb: VoiceCaptureCallbacks): void {
    this.onChunk = cb.onChunk;
    this.onError = cb.onError;
  }
}

/** Map getUserMedia failures to actionable Chinese messages. */
export function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '麦克风权限被拒绝，请在系统设置中允许 DUYA 访问麦克风';
    case 'NotFoundError':
      return '未找到可用的麦克风设备，请检查设备连接';
    case 'OverconstrainedError':
      return '所选麦克风不可用，请在语音设置中重新选择输入设备';
    case 'NotReadableError':
      return '麦克风被其他应用占用或无法读取，请关闭占用后重试';
    case 'AbortError':
      return '无法启动麦克风，请重试';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
