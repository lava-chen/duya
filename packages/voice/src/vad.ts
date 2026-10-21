/**
 * Voice activity detection + watchdogs.
 *
 * Pure logic over 16 kHz mono PCM blocks. Energy-threshold VAD detects
 * speech <-> silence; timers are tracked in **milliseconds derived from the
 * sample count**, so the caller may push blocks of any size (2.7 ms worklet
 * quanta, 200 ms batched chunks, or anything in between) without affecting
 * the timing semantics. The caller drives the timers (no setTimeout here so
 * the logic stays testable and framework-agnostic).
 */

export const VAD_SAMPLE_RATE = 16000;

export interface VadOptions {
  /** RMS threshold below which audio counts as silence (0..1). */
  silenceRms: number;
  /** Consecutive tail silence (ms) that finalizes the utterance. */
  endSilenceMs: number;
  /** Elapsed time (ms) with no speech at all that triggers a no-speech cancel. */
  noSpeechTimeoutMs: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  silenceRms: 0.02,
  endSilenceMs: 900,
  noSpeechTimeoutMs: 4000,
};

/** RMS of an Int16 PCM block, normalized to 0..1. */
export function rms(block: Int16Array): number {
  if (block.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i++) {
    const v = block[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / block.length);
}

export type VadState =
  | { kind: 'idle' } // no speech yet
  | { kind: 'speaking' } // in-utterance
  | { kind: 'finalize' } // tail silence reached → call finalize
  | { kind: 'no_speech' }; // no speech for too long → cancel

export class Vad {
  private totalSamples = 0;
  private silenceSamples = 0;
  private hasSpeech = false;
  private readonly opts: VadOptions;

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD_OPTIONS, ...opts };
  }

  /** Feed one PCM block (any length); returns the resulting state. */
  push(block: Int16Array): VadState {
    this.totalSamples += block.length;
    const isSilent = rms(block) < this.opts.silenceRms;

    if (!this.hasSpeech) {
      if (!isSilent) {
        this.hasSpeech = true;
        this.silenceSamples = 0;
        return { kind: 'speaking' };
      }
      if (this.elapsedMs() >= this.opts.noSpeechTimeoutMs) {
        return { kind: 'no_speech' };
      }
      return { kind: 'idle' };
    }

    // In-utterance.
    if (isSilent) {
      this.silenceSamples += block.length;
      if (this.silenceMs() >= this.opts.endSilenceMs) {
        return { kind: 'finalize' };
      }
      return { kind: 'speaking' };
    }
    this.silenceSamples = 0;
    return { kind: 'speaking' };
  }

  /** Elapsed audio (ms) since the last reset. */
  elapsedMs(): number {
    return (this.totalSamples / VAD_SAMPLE_RATE) * 1000;
  }

  /** Current consecutive silence duration (ms). */
  silenceMs(): number {
    return (this.silenceSamples / VAD_SAMPLE_RATE) * 1000;
  }

  reset(): void {
    this.totalSamples = 0;
    this.silenceSamples = 0;
    this.hasSpeech = false;
  }
}
