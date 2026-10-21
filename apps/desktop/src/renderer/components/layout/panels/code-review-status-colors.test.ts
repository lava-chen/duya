/**
 * code-review-status-colors.test.ts — static source assertions for the
 * code-review status palette (ISS-45).
 *
 * Two of the four file-status colours were hex literals in BOTH
 * `code-review.css` and `CodeReviewPanel.tsx`, so a palette change in one
 * place silently failed to apply in the other. They are panel-scoped CSS
 * tokens now, and this pins that the component keeps referencing them.
 *
 * Static rather than rendered on purpose: the defect was duplication
 * between two source files, which no amount of DOM rendering observes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const PANEL_SOURCE = read("./CodeReviewPanel.tsx");
const PANEL_CSS = read("../../../styles/code-review.css");

/** token name -> the hex it must resolve to. */
const STATUS_TOKENS = {
  "--review-add": "#31c578",
  "--review-remove": "#ef6262",
  "--review-modified": "#f39a49",
  "--review-renamed": "#b68cff",
} as const;

describe("code-review status palette", () => {
  it.each(Object.entries(STATUS_TOKENS))(
    "declares %s on the panel scope",
    (token, hex) => {
      const scope = PANEL_CSS.slice(
        PANEL_CSS.indexOf(".code-review-panel {"),
        PANEL_CSS.indexOf("}", PANEL_CSS.indexOf(".code-review-panel {")),
      );
      expect(scope).toContain(`${token}: ${hex};`);
    },
  );

  it("keeps the status hexes out of the component", () => {
    for (const hex of Object.values(STATUS_TOKENS)) {
      expect(PANEL_SOURCE).not.toContain(hex);
    }
  });

  it("maps every status to a token rather than a literal", () => {
    // statusColor() is a switch over added/untracked/deleted/renamed and a
    // default. All four arms must resolve to a var() reference.
    const fn = PANEL_SOURCE.slice(
      PANEL_SOURCE.indexOf("function statusColor"),
      PANEL_SOURCE.indexOf("function StatusIcon"),
    );
    expect(fn).toContain("var(--review-add)");
    expect(fn).toContain("var(--review-remove)");
    expect(fn).toContain("var(--review-renamed)");
    expect(fn).toContain("var(--review-modified)");
    expect(fn).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("uses the tokens in the stylesheet rules too", () => {
    expect(PANEL_CSS).toContain("color: var(--review-modified);");
    expect(PANEL_CSS).toContain("color: var(--review-renamed);");
    expect(PANEL_CSS).toContain("color-mix(in srgb, var(--review-modified) 16%, transparent)");
    expect(PANEL_CSS).toContain("color-mix(in srgb, var(--review-renamed) 16%, transparent)");
  });

  it("leaves no bare status hex anywhere in the stylesheet", () => {
    for (const hex of Object.values(STATUS_TOKENS)) {
      const occurrences = PANEL_CSS.split(hex).length - 1;
      // Exactly one: the token declaration itself.
      expect(occurrences).toBe(1);
    }
  });
});
