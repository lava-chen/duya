// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OfficePanel } from "./OfficePanel";
import type { PageTab } from "./registry";

const mocks = vi.hoisted(() => ({
  closePanel: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("@/hooks/usePanel", () => ({
  usePanel: () => ({ closePanel: mocks.closePanel }),
  useOptionalPanel: () => ({ workspaceExpanded: false }),
}));

// OfficePanel renders its labels through useTranslation. Delegate t() to the
// real zh dictionary so assertions match the actual user-facing strings.
vi.mock("@/hooks/useTranslation", async () => {
  const { translate } = await import("@/i18n");
  return {
    useTranslation: () => ({
      locale: "zh",
      setLocale: () => {},
      isLoading: false,
      t: (key: never, params?: Record<string, string | number>) =>
        translate("zh", key, params),
    }),
  };
});

function tab(filePath?: string): PageTab {
  return {
    id: "office-test",
    pageId: "office",
    title: filePath?.split("/").pop() || "Office",
    params: filePath ? { filePath } : undefined,
  };
}

describe("OfficePanel", () => {
  beforeEach(() => {
    mocks.closePanel.mockClear();
    mocks.parse.mockReset();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        dialog: { openOfficeFiles: vi.fn() },
        parser: { parse: mocks.parse },
        shell: { openPath: vi.fn() },
      } as unknown as Window["electronAPI"],
    });
  });

  it("shows the Office picker when no file is open", () => {
    render(<OfficePanel tab={tab()} embedded />);
    expect(screen.getByText("Open an Office file")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open file/i })).toBeTruthy();
  });

  it("renders spreadsheet cells and sends a selected cell to DUYA", async () => {
    mocks.parse.mockResolvedValue({
      chunks: [{
        type: "text",
        index: 0,
        text: "--- Sheet: Metrics ---\nA1: Period | B1: Value\nA2: June | B2: 42",
      }],
    });
    const addFile = vi.fn();
    const addText = vi.fn();
    window.addEventListener("file-tree-add-to-input", addFile);
    window.addEventListener("browser-add-to-input", addText);

    render(<OfficePanel tab={tab("C:/workspace/metrics.xlsx")} embedded />);

    const cell = await screen.findByRole("button", { name: "Period" });
    fireEvent.click(cell);
    fireEvent.click(screen.getByRole("button", { name: /问问 DUYA/i }));

    await waitFor(() => expect(addFile).toHaveBeenCalledOnce());
    expect((addFile.mock.calls[0][0] as CustomEvent).detail.path).toBe("C:/workspace/metrics.xlsx");
    const prompt = (addText.mock.calls[0][0] as CustomEvent).detail.text as string;
    expect(prompt).toContain("位置：Metrics!A1");
    expect(prompt).toContain("Period");

    window.removeEventListener("file-tree-add-to-input", addFile);
    window.removeEventListener("browser-add-to-input", addText);
  });
});
