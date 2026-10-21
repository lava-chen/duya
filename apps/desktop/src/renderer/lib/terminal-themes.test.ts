// @vitest-environment jsdom

// Unit tests for terminal theme resolution: the 'auto' CSS-var bridge and the
// fixed named palettes.

import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAutoTerminalTheme,
  resolveTerminalTheme,
  TERMINAL_THEME_PRESETS,
} from "./terminal-themes";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("resolveAutoTerminalTheme", () => {
  it("reads the app theme CSS variables", () => {
    document.documentElement.style.setProperty("--terminal-bg", "#123456");
    document.documentElement.style.setProperty("--text", "#abcdef");
    const theme = resolveAutoTerminalTheme();
    expect(theme.background).toBe("#123456");
    expect(theme.foreground).toBe("#abcdef");
  });

  it("falls back to dark defaults when the variables are unset", () => {
    const theme = resolveAutoTerminalTheme();
    expect(theme.background).toBe("#111111");
    expect(theme.red).toBe("#f7768e");
  });
});

describe("resolveTerminalTheme", () => {
  it("resolves named presets to their fixed palettes", () => {
    expect(resolveTerminalTheme("dracula").background).toBe("#282a36");
    expect(resolveTerminalTheme("nord").background).toBe("#2e3440");
    expect(resolveTerminalTheme("tokyonight").background).toBe("#1a1b26");
    expect(resolveTerminalTheme("solarized").background).toBe("#002b36");
    expect(resolveTerminalTheme("gruvbox").background).toBe("#282828");
  });

  it("resolves 'auto' through the CSS-var bridge", () => {
    expect(resolveTerminalTheme("auto")).toEqual(resolveAutoTerminalTheme());
  });

  it("every preset has a three-stop swatch and a resolvable palette", () => {
    for (const preset of TERMINAL_THEME_PRESETS) {
      expect(preset.swatch).toHaveLength(3);
      expect(resolveTerminalTheme(preset.id).background).toBeTruthy();
    }
  });
});
