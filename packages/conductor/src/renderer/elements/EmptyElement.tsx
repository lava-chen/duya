import type { ElementComponentProps } from "./ElementRegistry";

export function EmptyElement({ element }: Partial<ElementComponentProps> & { element: ElementComponentProps["element"] }) {
  return (
    <div className="flex items-center justify-center h-full text-xs text-[var(--muted)]">
      {element.elementKind}: No content
    </div>
  );
}