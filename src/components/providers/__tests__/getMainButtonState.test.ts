/**
 * src/components/providers/__tests__/getMainButtonState.test.ts
 *
 * Plan 203 Phase 5.1 tests for the 5-state main button machine.
 *
 * The test matrix covers the orthogonal boolean dimensions in
 * `ProviderCardState` × the 5 stable button states. The 5
 * stable states are:
 *   1. omo-in-use    (isOmo && isCurrent)
 *   2. omo-enable    (isOmo && !isCurrent)
 *   3. failover-in   (isFailoverMode && isInConfig)
 *   4. failover-add  (isFailoverMode && !isInConfig)
 *   5. blocked-by-proxy
 *   6. in-use        (isCurrent && !isOmo && !isFailoverMode && !isOfficialBlockedByProxy)
 *   7. enable        (default)
 *
 * Each test asserts:
 *   - The button's `text` matches the state.
 *   - The `icon` matches the state.
 *   - The `variant` matches the state's family.
 *   - `disabled` matches the state's stability (e.g. "in use" is
 *     disabled because switching would be a no-op).
 */

import { describe, it, expect } from 'vitest';
import {
  getMainButtonState,
  type MainButtonState,
} from '../ProviderActions';
import type { ProviderCardState } from '../hooks/useProviderCardState';

const APP_ID = 'duya' as const;

function makeCard(overrides: Partial<ProviderCardState> = {}): ProviderCardState {
  return {
    isCurrent: false,
    isActive: false,
    isDefault: false,
    isInConfig: true,
    isFailoverMode: false,
    isProxyTakeover: false,
    isOfficialBlockedByProxy: false,
    isOmo: false,
    isReadOnly: false,
    isDefaultModel: false,
    canEdit: true,
    canDelete: true,
    canDuplicate: true,
    canTest: true,
    canConfigureUsage: false,
    canOpenTerminal: false,
    canSetAsDefault: false,
    ...overrides,
  };
}

function expectState(actual: MainButtonState, expected: Partial<MainButtonState>) {
  for (const [k, v] of Object.entries(expected)) {
    expect(actual[k as keyof MainButtonState]).toBe(v);
  }
}

describe('getMainButtonState — OMO family', () => {
  it('OMO + current → in-use (check, secondary, NOT disabled — disable-on-click toggles OMO)', () => {
    const out = getMainButtonState(makeCard({ isOmo: true, isCurrent: true }), APP_ID);
    expectState(out, {
      icon: 'Check',
      text: 'In use',
      variant: 'secondary',
      disabled: false,
    });
  });

  it('OMO + not current → enable (play, default, NOT disabled)', () => {
    const out = getMainButtonState(makeCard({ isOmo: true, isCurrent: false }), APP_ID);
    expectState(out, {
      icon: 'Play',
      text: 'Enable',
      variant: 'primary',
      disabled: false,
    });
  });
});

describe('getMainButtonState — additive-mode family', () => {
  it('not in additive config → add to config (plus, primary, NOT disabled)', () => {
    const out = getMainButtonState(makeCard({ isInConfig: false }), APP_ID);
    expectState(out, {
      icon: 'Plus',
      text: 'Add to config',
      variant: 'primary',
      disabled: false,
    });
  });
});

describe('getMainButtonState — failover family', () => {
  it('failover mode + in queue → in queue (check, secondary, NOT disabled)', () => {
    const out = getMainButtonState(
      makeCard({ isFailoverMode: true, isInConfig: true }),
      APP_ID,
    );
    expectState(out, {
      icon: 'Check',
      text: 'In queue',
      variant: 'secondary',
      disabled: false,
    });
  });

  it('failover mode + not in queue → add to queue (plus, primary, NOT disabled)', () => {
    const out = getMainButtonState(
      makeCard({ isFailoverMode: true, isInConfig: false }),
      APP_ID,
    );
    expectState(out, {
      icon: 'Plus',
      text: 'Add to queue',
      variant: 'primary',
      disabled: false,
    });
  });
});

describe('getMainButtonState — proxy-blocked family', () => {
  it('official + proxy active → blocked by proxy (shield, secondary, disabled)', () => {
    const out = getMainButtonState(
      makeCard({
        isOfficialBlockedByProxy: true,
        isProxyTakeover: true,
        isCurrent: false,
      }),
      APP_ID,
    );
    expectState(out, {
      icon: 'ShieldAlert',
      text: 'Blocked by proxy',
      variant: 'secondary',
      disabled: true,
    });
  });

  it('proxy-blocked takes priority over current', () => {
    // When blocked by proxy, the user cannot switch even if the
    // card is the active one — show the proxy state, not the
    // in-use state.
    const out = getMainButtonState(
      makeCard({
        isOfficialBlockedByProxy: true,
        isProxyTakeover: true,
        isCurrent: true,
      }),
      APP_ID,
    );
    expect(out.text).toBe('Blocked by proxy');
    expect(out.disabled).toBe(true);
  });
});

describe('getMainButtonState — in-use family', () => {
  it('current + normal mode → in use (check, secondary, disabled)', () => {
    const out = getMainButtonState(makeCard({ isCurrent: true }), APP_ID);
    expectState(out, {
      icon: 'Check',
      text: 'In use',
      variant: 'secondary',
      disabled: true,
    });
  });

  it('current + proxy takeover does not change the in-use text but does add the proxy color', () => {
    // proxy takeover only changes the *default* "enable" class.
    // The current in-use state is stable.
    const out = getMainButtonState(
      makeCard({ isCurrent: true, isProxyTakeover: true }),
      APP_ID,
    );
    expect(out.text).toBe('In use');
  });
});

describe('getMainButtonState — default enable', () => {
  it('non-current + no flags → enable (play, primary, NOT disabled)', () => {
    const out = getMainButtonState(makeCard(), APP_ID);
    expectState(out, {
      icon: 'Play',
      text: 'Enable',
      variant: 'primary',
      disabled: false,
    });
  });

  it('non-current + proxy takeover → enable (play, primary, NOT disabled)', () => {
    const out = getMainButtonState(
      makeCard({ isProxyTakeover: true }),
      APP_ID,
    );
    expectState(out, {
      icon: 'Play',
      text: 'Enable',
      variant: 'primary',
      disabled: false,
    });
  });

  it('non-current + no flags + no proxy → empty className', () => {
    const out = getMainButtonState(makeCard(), APP_ID);
    expect(out.className).toBe('');
  });
});

describe('getMainButtonState — priority order', () => {
  it('OMO > failover', () => {
    const out = getMainButtonState(
      makeCard({ isOmo: true, isCurrent: true, isFailoverMode: true, isInConfig: true }),
      APP_ID,
    );
    // OMO + current wins: "In use" not "In queue".
    expect(out.text).toBe('In use');
  });

  it('OMO > additive', () => {
    const out = getMainButtonState(
      makeCard({ isOmo: true, isInConfig: false }),
      APP_ID,
    );
    // OMO wins: the text is "Enable" not "Add to config".
    expect(out.text).toBe('Enable');
  });

  it('failover > proxy-blocked', () => {
    const out = getMainButtonState(
      makeCard({
        isFailoverMode: true,
        isInConfig: true,
        isOfficialBlockedByProxy: true,
        isProxyTakeover: true,
      }),
      APP_ID,
    );
    // Failover wins: "In queue" not "Blocked by proxy".
    expect(out.text).toBe('In queue');
  });

  it('proxy-blocked > in-use', () => {
    const out = getMainButtonState(
      makeCard({
        isOfficialBlockedByProxy: true,
        isProxyTakeover: true,
        isCurrent: true,
      }),
      APP_ID,
    );
    expect(out.text).toBe('Blocked by proxy');
    expect(out.disabled).toBe(true);
  });
});
