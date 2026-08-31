import { describe, it, expect } from 'vitest';
import { describeStartError, VOICE_ERROR_MESSAGES } from './errors';

describe('describeStartError (voice:start failure mapping)', () => {
  it('maps voice_disabled to a model_not_ready code with setup guidance', () => {
    const r = describeStartError('voice_disabled');
    expect(r.code).toBe('model_not_ready');
    expect(r.message).toContain('语音输入未启用');
  });

  it('maps model_not_ready and preserves the raw message', () => {
    const r = describeStartError('model_not_ready', 'whisper missing');
    expect(r.code).toBe('model_not_ready');
    expect(r.message).toContain('whisper missing');
  });

  it('maps cloud_engine_not_ready to setup guidance', () => {
    const r = describeStartError('cloud_engine_not_ready');
    expect(r.code).toBe('model_not_ready');
    expect(r.message).toContain('云端语音识别未就绪');
  });

  it('maps permission_denied and network codes verbatim', () => {
    expect(describeStartError('permission_denied').code).toBe('permission_denied');
    expect(describeStartError('network').code).toBe('network');
  });

  it('falls back to internal for unknown errors', () => {
    const r = describeStartError('weird_code', 'boom');
    expect(r.code).toBe('internal');
    expect(r.message).toBe('boom');
  });
});

describe('VOICE_ERROR_MESSAGES', () => {
  it('provides Chinese copy for every VoiceErrorCode', () => {
    // Regression guard: any new VoiceErrorCode must have a message here.
    expect(Object.keys(VOICE_ERROR_MESSAGES).sort()).toEqual(
      ['internal', 'model_not_ready', 'network', 'no_speech', 'permission_denied'].sort(),
    );
  });
});