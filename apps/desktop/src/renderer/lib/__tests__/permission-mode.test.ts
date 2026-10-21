import { describe, expect, it } from 'vitest';
import { uiPermissionModeToSettings } from '../permission-mode';

describe('permission-mode helpers', () => {
  it('maps UI mode to settings mode', () => {
    expect(uiPermissionModeToSettings('ask')).toBe('default');
    expect(uiPermissionModeToSettings('auto')).toBe('auto');
    expect(uiPermissionModeToSettings('bypass')).toBe('bypass');
  });
});
