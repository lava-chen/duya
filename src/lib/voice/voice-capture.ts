// src/lib/voice/voice-capture.ts — mic → 16 kHz mono PCM16 → IPC to Main.
//
// Uses an AudioWorklet (loaded from an inline Blob URL) to downmix to mono
// and downsample to 16 kHz, emitting Int16 PCM blocks that are forwarded to
// the Main-process STT worker via `electronAPI.voice.transcribeChunk`.
// No native dependencies run in the renderer.

const TARGET_RATE = 16000;

const WORKLET_SOURCE = `
class PcmDownmixProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetRate = sampleRate;
    this._ratio = 1;
    this._buffer = new Float32Array(0);
    this.port.onmessage = (e) => {
      if (e.data && e.data.targetRate) {
        this._targetRate = e.data.targetRate;
        this._ratio = sampleRate / this._targetRate;
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

    const step = this._ratio;
    const outLen = Math.floor(this._buffer.length / step);
    if (outLen < 1) return true;
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.min(Math.floor(i * step), this._buffer.length - 1);
      const s = Math.max(-1, Math.min(1, this._buffer[idx]));
      out[i] = (s * 32767) | 0;
    }
    const consumed = Math.floor(outLen * step);
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

export interface VoiceCapture {
  start(): Promise<boolean>;
  stop(): void;
  readonly active: boolean;
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

  async start(): Promise<boolean> {
    if (this._active) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.stream = stream;

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
      source.connect(node);
      node.connect(ctx.destination);

      node.port.postMessage({ targetRate: TARGET_RATE });

      this.ctx = ctx;
      this.source = source;
      this.node = node;
      this._active = true;
      return true;
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : String(err));
      this.stop();
      return false;
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
      this.stream?.getTracks().forEach((t) => t.stop());
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