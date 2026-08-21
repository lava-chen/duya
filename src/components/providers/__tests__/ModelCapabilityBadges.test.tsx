/**
 * src/components/providers/__tests__/ModelCapabilityBadges.test.tsx
 *
 * Unit tests for the capability-badge component. Renders one pill per
 * `true` flag (vision / tool-use / reasoning), an uppercase format tag
 * for `format`, and a green dot for `isLoaded`. Returns `null` when
 * no flags or `isLoaded` are set so the caller can drop it into any
 * model list without preconditions.
 */

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ModelCapabilityBadges } from '../ModelCapabilityBadges';

describe('ModelCapabilityBadges', () => {
  it('renders nothing for a model with no flags, no format, no isLoaded', () => {
    const { container } = render(<ModelCapabilityBadges />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a single vision pill when supportsVision=true', () => {
    render(<ModelCapabilityBadges vision />);
    expect(screen.getByTestId('model-cap-badge-vision')).toBeTruthy();
    expect(screen.getByText('vision')).toBeTruthy();
    expect(screen.queryByTestId('model-cap-badge-tool-use')).toBeNull();
    expect(screen.queryByTestId('model-cap-badge-reasoning')).toBeNull();
  });

  it('renders tool-use and reasoning pills when set', () => {
    render(<ModelCapabilityBadges toolUse reasoning />);
    expect(screen.getByTestId('model-cap-badge-tool-use')).toBeTruthy();
    expect(screen.getByTestId('model-cap-badge-reasoning')).toBeTruthy();
    expect(screen.getByText('tool-use')).toBeTruthy();
    expect(screen.getByText('reasoning')).toBeTruthy();
  });

  it('does NOT render a pill for an explicit `false` (known false, not unknown)', () => {
    render(<ModelCapabilityBadges vision={false} toolUse />);
    expect(screen.queryByTestId('model-cap-badge-vision')).toBeNull();
    expect(screen.getByTestId('model-cap-badge-tool-use')).toBeTruthy();
  });

  it('renders the format tag when present', () => {
    render(<ModelCapabilityBadges format="gguf" />);
    expect(screen.getByTestId('model-cap-badge-format')).toBeTruthy();
    expect(screen.getByText('gguf')).toBeTruthy();
  });

  it('does NOT render the format tag for null or empty string', () => {
    const { container: c1 } = render(<ModelCapabilityBadges format={null} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(<ModelCapabilityBadges format="" />);
    expect(c2.firstChild).toBeNull();
  });

  it('renders the loaded dot when isLoaded=true (even without any other flag)', () => {
    const { container } = render(<ModelCapabilityBadges isLoaded />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('model-cap-badge-loaded')).toBeTruthy();
    expect(screen.getByLabelText('loaded')).toBeTruthy();
  });

  it('does NOT render the loaded dot for isLoaded=false (explicitly not loaded)', () => {
    const { container } = render(<ModelCapabilityBadges isLoaded={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('combines all flags + format + isLoaded in one row', () => {
    render(
      <ModelCapabilityBadges
        vision
        toolUse
        reasoning
        format="mlx"
        isLoaded
      />,
    );
    expect(screen.getByTestId('model-cap-badge-vision')).toBeTruthy();
    expect(screen.getByTestId('model-cap-badge-tool-use')).toBeTruthy();
    expect(screen.getByTestId('model-cap-badge-reasoning')).toBeTruthy();
    expect(screen.getByTestId('model-cap-badge-format')).toBeTruthy();
    expect(screen.getByTestId('model-cap-badge-loaded')).toBeTruthy();
  });
});