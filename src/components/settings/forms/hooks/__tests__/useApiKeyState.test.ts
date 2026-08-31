/**
 * src/components/settings/forms/hooks/__tests__/useApiKeyState.test.ts
 *
 * Plan 209 Phase H tests for the 3-state api key machine.
 *
 * The pre-Plan-209 tests asserted `hasUserApiKey`; that field is gone.
 * We re-target the assertions to `keyState`.
 */

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useApiKeyState } from '../useApiKeyState';

describe('useApiKeyState — Plan 209 3-state machine', () => {
  it('starts untouched with no initial value', () => {
    const { result } = renderHook(() => useApiKeyState());
    expect(result.current.apiKey).toBe('');
    expect(result.current.maskedApiKey).toBe('');
    expect(result.current.keyState).toBe('untouched');
    expect(result.current.revealApiKey).toBe(false);
  });

  it('treats initial.apiKey as user input only when it is not a mask', () => {
    const { result } = renderHook(() => useApiKeyState({ apiKey: 'sk-test-1234567890' }));
    expect(result.current.apiKey).toBe('sk-test-1234567890');
    expect(result.current.maskedApiKey).toBe('');
    expect(result.current.keyState).toBe('replaced');
  });

  it('auto-detects a mask in initial.apiKey and stays untouched', () => {
    const { result } = renderHook(() => useApiKeyState({ apiKey: 'sk-a***cdef' }));
    expect(result.current.apiKey).toBe('');
    expect(result.current.maskedApiKey).toBe('sk-a***cdef');
    expect(result.current.keyState).toBe('untouched');
  });

  it('preserves initial.masked until the user types', () => {
    const { result } = renderHook(() => useApiKeyState({ masked: 'sk-a***cdef' }));
    expect(result.current.apiKey).toBe('');
    expect(result.current.maskedApiKey).toBe('sk-a***cdef');
    expect(result.current.keyState).toBe('untouched');
  });

  it('setApiKey moves to replaced AND keeps maskedApiKey as a hint', () => {
    const { result } = renderHook(() => useApiKeyState({ masked: 'sk-a***cdef' }));
    act(() => result.current.setApiKey('sk-raw-key-1234567890'));
    expect(result.current.apiKey).toBe('sk-raw-key-1234567890');
    // The mask is preserved so the UI can still show "current: sk-a***cdef"
    // alongside the input. This is the fix for the original bug: the
    // mask is no longer the value being persisted.
    expect(result.current.maskedApiKey).toBe('sk-a***cdef');
    expect(result.current.keyState).toBe('replaced');
  });

  it('setApiKey("") returns to untouched but keeps the mask', () => {
    const { result } = renderHook(() => useApiKeyState({ masked: 'sk-a***cdef' }));
    act(() => result.current.setApiKey('first'));
    act(() => result.current.setApiKey(''));
    expect(result.current.apiKey).toBe('');
    expect(result.current.maskedApiKey).toBe('sk-a***cdef');
    expect(result.current.keyState).toBe('untouched');
  });

  it('clearApiKey moves to cleared and drops the mask', () => {
    const { result } = renderHook(() => useApiKeyState({ masked: 'sk-a***cdef' }));
    act(() => result.current.clearApiKey());
    expect(result.current.apiKey).toBe('');
    expect(result.current.maskedApiKey).toBe('');
    expect(result.current.keyState).toBe('cleared');
  });

  it('toggleReveal flips the flag', () => {
    const { result } = renderHook(() => useApiKeyState());
    expect(result.current.revealApiKey).toBe(false);
    act(() => result.current.toggleReveal());
    expect(result.current.revealApiKey).toBe(true);
    act(() => result.current.toggleReveal());
    expect(result.current.revealApiKey).toBe(false);
  });

  it('subsequent setApiKey calls stay in replaced', () => {
    const { result } = renderHook(() => useApiKeyState({ masked: 'sk-a***cdef' }));
    act(() => result.current.setApiKey('first'));
    act(() => result.current.setApiKey('second'));
    expect(result.current.apiKey).toBe('second');
    expect(result.current.keyState).toBe('replaced');
  });
});
