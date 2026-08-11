/**
 * Voice activity detection + watchdogs.
 *
 * Pure logic over 16 kHz mono PCM blocks. Energy-threshold VAD detects
 * speech <-> silence; the caller drives the timers (no setTimeout here so
 * the logic stays testable and framework-agnostic).
 */

export interface VadOptions {
  /** RMS threshold below which a block counts as silence (0..1). */
  silenceRms: number;
  /** Number of consecutive silence blocks that finalize the utterance. */
  endSilenceBlocks: number;
  /** Blocks after start with no speech that trigger a no-speech cancel. */
  noSpeechBlocks: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  silenceRms: 0.02,
  endSilenceBlocks: 3, // 3 * 200ms = 600ms tail silence
  noSpeechBlocks: 20, // 20 * 200ms = 4s no-speech timeout
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
  private silenceCount = 0;
  private blockCount = 0;
  private hasSpeech = false;
  private readonly opts: VadOptions;

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD_OPTIONS, ...opts };
  }

  /** Feed one PCM block; returns the resulting state. */
  push(block: Int16Array): VadState {
    this.blockCount++;
    const isSilent = rms(block) < this.opts.silenceRms;

    if (!this.hasSpeech) {
      if (!isSilent) {
        this.hasSpeech = true;
        this.silenceCount = 0;
        return { kind: 'speaking' };
      }
      if (this.blockCount >= this.opts.noSpeechBlocks) {
        return { kind: 'no_speech' };
      }
      return { kind: 'idle' };
    }

    // In-utterance.
    if (isSilent) {
      this.silenceCount++;
      if (this.silenceCount >= this.opts.endSilenceBlocks) {
        return { kind: 'finalize' };
      }
      return { kind: 'speaking' };
    }
    this.silenceCount = 0;
    return { kind: 'speaking' };
  }

  reset(): void {
    this.silenceCount = 0;
    this.blockCount = 0;
    this.hasSpeech = false;
  }
}