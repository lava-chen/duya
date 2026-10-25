// @vitest-environment jsdom

// The panel registry is on the FIRST SCREEN: the app shell imports it while
// the renderer is still booting, so every panel it reaches statically is
// downloaded, parsed and evaluated before the first screen can paint.
//
// A panel the user opens explicitly must not be in that graph. The terminal is
// the expensive one — it drags in xterm plus four addons (core, fit,
// web-links, unicode11, webgl) — and a static import put all of it into the
// first-screen closure.
//
// This file pins the invariant: importing the registry must not evaluate the
// terminal's dependency tree, and the terminal must stay a lazy component.

import { describe, expect, it, vi } from "vitest";

const terminalModules = vi.hoisted(() => {
  const evaluated: string[] = [];
  const stub = (name: string) => () => {
    evaluated.push(name);
    return {
      Terminal: class {},
      FitAddon: class {},
      WebLinksAddon: class {},
      Unicode11Addon: class {},
      WebglAddon: class {},
    };
  };
  return { evaluated, stub };
});

vi.mock("@xterm/xterm", terminalModules.stub("xterm"));
vi.mock("@xterm/addon-fit", terminalModules.stub("addon-fit"));
vi.mock("@xterm/addon-web-links", terminalModules.stub("addon-web-links"));
vi.mock("@xterm/addon-unicode11", terminalModules.stub("addon-unicode11"));
vi.mock("@xterm/addon-webgl", terminalModules.stub("addon-webgl"));

import { PAGE_REGISTRY } from "./registry";

describe("the panel registry", () => {
  it("keeps the terminal out of the first-screen module graph", async () => {
    // Importing the registry is what the app shell does during boot.
    await import("./registry");
    expect(terminalModules.evaluated).toEqual([]);
  });

  it("loads the terminal panel on demand", () => {
    const descriptor = PAGE_REGISTRY.terminal;
    // A React.lazy component carries this marker; a plain component does not.
    const marker = (descriptor.component as unknown as { $$typeof?: symbol }).$$typeof;
    expect(marker).toBe(Symbol.for("react.lazy"));
  });
});
