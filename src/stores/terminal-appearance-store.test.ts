// @vitest-environment jsdom

// Unit tests for the terminal appearance store: clamping and clamped stepping.

import { beforeEach, describe, expect, it } from "vitest";
import {
  clampTerminalFontSize,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  useTerminalAppearanceStore,
} from "./terminal-appearance-store";

describe("clampTerminalFontSize", () => {
  it("clamps to the supported range", () => {
    expect(clampTerminalFontSize(1)).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(clampTerminalFontSize(999)).toBe(TERMINAL_FONT_SIZE_MAX);
    expect(clampTerminalFontSize(15)).toBe(15);
  });

  it("rounds fractional sizes and rejects non-finite input", () => {
    expect(clampTerminalFontSize(15.4)).toBe(15);
    expect(clampTerminalFontSize(15.6)).toBe(16);
    expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE_DEFAULT);
    expect(clampTerminalFontSize(Number.POSITIVE_INFINITY)).toBe(TERMINAL_FONT_SIZE_DEFAULT);
  });
});

describe("terminal appearance store", () => {
  beforeEach(() => {
    useTerminalAppearanceStore.setState({
      fontSize: TERMINAL_FONT_SIZE_DEFAULT,
      themeId: "auto",
    });
  });

  it("steps the font size and stops at the boundaries", () => {
    const { stepFontSize } = useTerminalAppearanceStore.getState();
    stepFontSize(1);
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(TERMINAL_FONT_SIZE_DEFAULT + 1);

    // Overflowing the upper bound keeps the max value.
    for (let i = 0; i < 100; i += 1) stepFontSize(1);
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(TERMINAL_FONT_SIZE_MAX);

    for (let i = 0; i < 100; i += 1) stepFontSize(-1);
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(TERMINAL_FONT_SIZE_MIN);
  });

  it("resets to the default font size", () => {
    const { setFontSize, resetFontSize } = useTerminalAppearanceStore.getState();
    setFontSize(20);
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(20);
    resetFontSize();
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(TERMINAL_FONT_SIZE_DEFAULT);
  });

  it("stores the selected theme id", () => {
    useTerminalAppearanceStore.getState().setThemeId("dracula");
    expect(useTerminalAppearanceStore.getState().themeId).toBe("dracula");
  });
});
