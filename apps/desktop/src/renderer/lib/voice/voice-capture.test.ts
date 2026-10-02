import { describe, it, expect } from 'vitest';
import { buildAudioConstraints, describeMediaError } from './voice-capture';

describe('buildAudioConstraints (deviceId propagation)', () => {
  it('uses the system default (no deviceId) when deviceId is empty/undefined', () => {
    expect(buildAudioConstraints(undefined).deviceId).toBeUndefined();
    expect(buildAudioConstraints('').deviceId).toBeUndefined();
  });

  it('pins the configured device with an exact constraint', () => {
    const c = buildAudioConstraints('dev-123');
    expect(c.deviceId).toEqual({ exact: 'dev-123' });
  });

  it('always requests mono + echo/noise/AEC processing', () => {
    const c = buildAudioConstraints('dev-123');
    expect(c.channelCount).toBe(1);
    expect(c.echoCancellation).toBe(true);
    expect(c.noiseSuppression).toBe(true);
    expect(c.autoGainControl).toBe(true);
  });
});

describe('describeMediaError (getUserMedia failure mapping)', () => {
  function domErr(name: string): DOMException {
    return new DOMException('', name);
  }

  it('maps NotAllowedError/SecurityError to permission guidance', () => {
    expect(describeMediaError(domErr('NotAllowedError'))).toContain('麦克风权限被拒绝');
    expect(describeMediaError(domErr('SecurityError'))).toContain('麦克风权限被拒绝');
  });

  it('maps NotFoundError / NotReadableError / OverconstrainedError / AbortError', () => {
    expect(describeMediaError(domErr('NotFoundError'))).toContain('未找到可用的麦克风');
    expect(describeMediaError(domErr('NotReadableError'))).toContain('被其他应用占用');
    expect(describeMediaError(domErr('OverconstrainedError'))).toContain('重新选择输入设备');
    expect(describeMediaError(domErr('AbortError'))).toContain('请重试');
  });

  it('falls back to the Error message for unknown failures', () => {
    expect(describeMediaError(new Error('unknown audio failure'))).toBe('unknown audio failure');
  });
});