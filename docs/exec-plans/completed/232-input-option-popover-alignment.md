# Plan: Input Option Popover Alignment

> **Status**: In Progress  
> **Priority**: P1  
> **Created**: 2026-07-17

## Goal

Unify high-frequency option pickers around the chat input into one compact,
searchable setting-panel pattern. The first slice covers model and project /
recent-session selection, while leaving non-equivalent controls (such as the
permission cycle toggle) unchanged.

## Scope

- [x] Add a reusable option-panel shell with search, keyboard navigation,
      selection state, empty state, and optional footer actions.
- [x] Migrate the chat model picker without changing its provider behavior.
- [x] Migrate the welcome project picker to the shared panel and preserve its
      project-creation actions.
- [x] Verify the project picker, its focused search input, empty state, and
      Escape close behavior in Playwright. Model-picker visual smoke remains
      unavailable in browser-only Vite because its provider API requires the
      Electron preload bridge; the clipped-popup root cause was confirmed in
      the live DOM layout and fixed.
- [x] Run `npm run typecheck:all` before the final UI adjustments; the later
      renderer-only delta passes `npx tsc --noEmit`.

## Guardrails

- Keep project creation and folder-selection actions available from the panel.
- Preserve model context-length metadata and the provider management action.
- Do not collapse permission confirmation into a generic selector: it has a
  distinct safety flow.
