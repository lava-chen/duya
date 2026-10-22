import { describe, expect, it } from "vitest";
import { computeFolds, indentDepth, tokenizeBlock } from "../fw-tokenize";

describe("tokenizeBlock", () => {
  it("returns one entry per input line", () => {
    const html = tokenizeBlock("const a = 1;\nconst b = 2;\n");
    expect(html).toHaveLength(3);
  });

  it("classifies keywords, strings and comments", () => {
    const [line] = tokenizeBlock('const name = "duya"; // trailing');
    expect(line).toContain("fw-t-decl");
    expect(line).toContain("fw-t-string");
    expect(line).toContain("fw-t-comment");
  });

  it("escapes html so file content cannot inject markup", () => {
    const [line] = tokenizeBlock("const view = <div />;");
    expect(line).toContain("&lt;");
    expect(line).not.toContain("<div");
  });

  it("keeps blank lines as empty entries", () => {
    const html = tokenizeBlock("a\n\nb");
    expect(html).toHaveLength(3);
    expect(html[1]).toBe("");
  });
});

describe("computeFolds", () => {
  it("maps an opening brace to its closing line", () => {
    const lines = ["function a() {", "  return 1;", "}", "const b = 2;"];
    const folds = computeFolds(lines);
    expect(folds.get(1)).toBe(3);
  });

  it("ignores braces inside strings and comments", () => {
    const lines = ['const s = "{ not a block }";', "const t = 1;"];
    expect(computeFolds(lines).size).toBe(0);
  });

  it("skips single-line blocks", () => {
    const lines = ["const o = { a: 1 };"];
    expect(computeFolds(lines).size).toBe(0);
  });

  it("handles nested blocks", () => {
    const lines = ["function a() {", "  if (x) {", "    y();", "  }", "}"];
    const folds = computeFolds(lines);
    expect(folds.get(1)).toBe(5);
    expect(folds.get(2)).toBe(4);
  });
});

describe("indentDepth", () => {
  it("counts two spaces as one level", () => {
    expect(indentDepth("    value")).toBe(2);
  });

  it("counts a tab as two spaces", () => {
    expect(indentDepth("\tvalue")).toBe(1);
  });

  it("returns zero for unindented lines", () => {
    expect(indentDepth("value")).toBe(0);
  });
});
