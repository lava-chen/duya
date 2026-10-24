// @vitest-environment jsdom
/**
 * The sidebar's memo comparator.
 *
 * The shell re-renders on every conversation-store write (the composer
 * persists the new-chat draft on every keystroke) and rebuilds `style` and
 * the capability object inline each time. The comparator is what stops that
 * from cascading a re-render through the whole sidebar tree, so its contract
 * is pinned here: value-equal churn compares EQUAL, and every prop that can
 * change what the sidebar shows compares UNEQUAL.
 *
 * `onExpand` is compared by identity on purpose: `app-sidebar.tsx` hands the
 * tree a STABLE callback (the shell's volatile closure is kept in a ref), so
 * identity churn never reaches the comparator.
 */
import { describe, it, expect } from 'vitest';
import { areSidebarPropsEqual } from '../sidebar/sidebar-props';

const capabilities = {
  localFileAccess: true,
  settings: true,
  extensions: true,
  bots: true,
  automation: true,
  workflows: true,
  turnConfiguration: true,
};

describe('areSidebarPropsEqual', () => {
  it('treats a re-created style object with the same width as equal', () => {
    expect(
      areSidebarPropsEqual(
        { style: { width: 300, minWidth: 300, maxWidth: 300 } },
        { style: { width: 300, minWidth: 300, maxWidth: 300 } },
      ),
    ).toBe(true);
  });

  it('treats a re-created onExpand callback as unequal', () => {
    // The tree receives a STABLE callback (the shell's volatile closure is
    // kept in a ref by `app-sidebar.tsx`), so two different callbacks are
    // two different behaviours and must not be treated as equal.
    expect(
      areSidebarPropsEqual({ onExpand: () => {} }, { onExpand: () => {} }),
    ).toBe(false);
  });

  it('treats the same onExpand callback as equal', () => {
    const onExpand = () => {};
    expect(areSidebarPropsEqual({ onExpand }, { onExpand })).toBe(true);
  });

  it('reacts to a width change', () => {
    expect(
      areSidebarPropsEqual(
        { style: { width: 300, minWidth: 300, maxWidth: 300 } },
        { style: { width: 320, minWidth: 320, maxWidth: 320 } },
      ),
    ).toBe(false);
  });

  it('reacts to a style key that appears or disappears', () => {
    expect(
      areSidebarPropsEqual({ style: { width: 300 } }, { style: { width: 300, height: 10 } }),
    ).toBe(false);
  });

  it('reacts to the collapsed flag', () => {
    expect(areSidebarPropsEqual({ collapsed: false }, { collapsed: true })).toBe(false);
  });

  it('reacts to the settings-page flag', () => {
    expect(areSidebarPropsEqual({ isSettingsPage: false }, { isSettingsPage: true })).toBe(false);
  });

  it('reacts to a capability flag change', () => {
    expect(
      areSidebarPropsEqual(
        { capabilities },
        { capabilities: { ...capabilities, bots: false } },
      ),
    ).toBe(false);
  });

  it('treats a re-created but identical capabilities object as equal', () => {
    expect(
      areSidebarPropsEqual(
        { capabilities },
        { capabilities: { ...capabilities } },
      ),
    ).toBe(true);
  });

  it('reacts to capabilities appearing or disappearing', () => {
    expect(areSidebarPropsEqual({ capabilities }, {})).toBe(false);
    expect(areSidebarPropsEqual({}, { capabilities })).toBe(false);
  });
});
