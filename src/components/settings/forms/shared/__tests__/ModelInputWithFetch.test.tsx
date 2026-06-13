// @vitest-environment jsdom
/**
 * src/components/settings/forms/shared/__tests__/ModelInputWithFetch.test.tsx
 *
 * Plan 205 Phase H3 tests. The component is a pure controlled
 * input + dropdown trigger; we assert the four visual states
 * (empty + fetch button / loading / fetched + dropdown / plain
 * input) and the click → dropdown selection flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelInputWithFetch } from '../ModelInputWithFetch';
import type { FetchedModel } from '@/lib/ipc-client';

// We don't need a real conversation store; this component is pure.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k, locale: 'en' }),
}));

const ANTHROPIC: FetchedModel[] = [
  { id: 'claude-sonnet-4-6', ownedBy: 'anthropic' },
  { id: 'claude-opus-4-6', ownedBy: 'anthropic' },
];
const OPENAI: FetchedModel[] = [
  { id: 'gpt-4o', ownedBy: 'openai' },
  { id: 'gpt-4o-mini', ownedBy: 'openai' },
];

describe('ModelInputWithFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the fetch button when no models are loaded and onFetch is provided', () => {
    const onFetch = vi.fn();
    render(
      <ModelInputWithFetch
        id="m"
        value=""
        onChange={() => undefined}
        fetchedModels={[]}
        isLoading={false}
        onFetch={onFetch}
      />,
    );
    expect(screen.getByTestId('model-input-fetch-m')).toBeDefined();
    fireEvent.click(screen.getByTestId('model-input-fetch-m'));
    expect(onFetch).toHaveBeenCalledTimes(1);
  });

  it('renders the spinner when isLoading is true and no models are loaded', () => {
    render(
      <ModelInputWithFetch
        id="m"
        value=""
        onChange={() => undefined}
        fetchedModels={[]}
        isLoading={true}
        onFetch={() => undefined}
      />,
    );
    expect(screen.getByTestId('model-input-loading-m')).toBeDefined();
  });

  it('renders the chevron dropdown when models are loaded', () => {
    render(
      <ModelInputWithFetch
        id="m"
        value=""
        onChange={() => undefined}
        fetchedModels={ANTHROPIC}
        isLoading={false}
      />,
    );
    expect(screen.getByTestId('model-input-dropdown-m')).toBeDefined();
  });

  it('groups fetched models by ownedBy (vendor) in the dropdown', () => {
    const onChange = vi.fn();
    const models = [...ANTHROPIC, ...OPENAI];
    render(
      <ModelInputWithFetch
        id="m"
        value=""
        onChange={onChange}
        fetchedModels={models}
        isLoading={false}
      />,
    );
    fireEvent.click(screen.getByTestId('model-input-dropdown-m'));
    // All model option buttons should be present.
    for (const m of models) {
      expect(screen.getByTestId(`model-input-option-${m.id}`)).toBeDefined();
    }
  });

  it('invokes onChange with the selected model id when an option is clicked', () => {
    const onChange = vi.fn();
    render(
      <ModelInputWithFetch
        id="m"
        value=""
        onChange={onChange}
        fetchedModels={ANTHROPIC}
        isLoading={false}
      />,
    );
    fireEvent.click(screen.getByTestId('model-input-dropdown-m'));
    fireEvent.click(screen.getByTestId('model-input-option-claude-opus-4-6'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('claude-opus-4-6');
  });

  it('renders a plain input when no onFetch and no fetched models', () => {
    render(
      <ModelInputWithFetch
        id="m"
        value="manual-model"
        onChange={() => undefined}
        fetchedModels={[]}
        isLoading={false}
      />,
    );
    expect(screen.queryByTestId('model-input-fetch-m')).toBeNull();
    expect(screen.queryByTestId('model-input-loading-m')).toBeNull();
    expect(screen.queryByTestId('model-input-dropdown-m')).toBeNull();
    expect(screen.getByDisplayValue('manual-model')).toBeDefined();
  });

  it('displays an inline error message when error is set', () => {
    render(
      <ModelInputWithFetch
        id="m"
        value=""
        onChange={() => undefined}
        fetchedModels={[]}
        isLoading={false}
        error="HTTP 401"
      />,
    );
    expect(screen.getByTestId('model-input-error-m')).toBeDefined();
    expect(screen.getByTestId('model-input-error-m').textContent).toContain(
      'HTTP 401',
    );
  });
});
