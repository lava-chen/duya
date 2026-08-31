/**
 * src/components/providers/__tests__/ProviderAddButton.test.tsx
 *
 * Plan 205 tests for the + Add provider button. The button
 * itself is just a trigger — clicking it navigates to the
 * `provider-picker` sub-view via the settings-tab store. The
 * picker is tested separately in `ProviderPickerView.test.tsx`.
 *
 * We assert the click navigates to the picker (we read the
 * store after the click) — that's the contract the settings
 * flow cares about.
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProviderAddButton } from '../ProviderAddButton';
import { useConversationStore } from '@/stores/conversation-store';

describe('ProviderAddButton', () => {
  beforeEach(() => {
    // Reset the store to a known initial state for every test.
    useConversationStore.setState({
      settingsTab: 'providers',
      providerEditTarget: null,
    });
  });

  it('renders the add button trigger', () => {
    render(<ProviderAddButton />);
    expect(screen.getByTestId('provider-add-button')).toBeDefined();
  });

  it('navigates to provider-picker when clicked', () => {
    render(<ProviderAddButton />);
    fireEvent.click(screen.getByTestId('provider-add-button'));
    expect(useConversationStore.getState().settingsTab).toBe(
      'provider-picker',
    );
  });

  it('calls the optional onAdd callback (reserved for future use)', () => {
    const onAdd = vi.fn();
    render(<ProviderAddButton onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('provider-add-button'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    // The store should also have been updated.
    expect(useConversationStore.getState().settingsTab).toBe(
      'provider-picker',
    );
  });
});
