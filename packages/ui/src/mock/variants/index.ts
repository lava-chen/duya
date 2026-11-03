/**
 * Structural variants of the shell.
 *
 * ## What a variant is
 *
 * The shell's big blocks are already named in the product's DOM:
 * `.app-sidebar-column`, `.app-content-column`, `.app-workspace-row`,
 * `.app-main-wrapper`, `.panel-zone`. A structural change — sidebar on top,
 * panel docked at the bottom, a wider rail — is a LAYOUT change to those
 * blocks, and layout is exactly what CSS can express.
 *
 * So a variant here is a stylesheet keyed on `html[data-shell-variant]`. It
 * never touches a product component, and the product never sees it: the
 * attribute is set by the mock entry only.
 *
 * ## How to add one
 *
 * 1. Add a rule to `variants.css` under `[data-shell-variant="<id>"]`.
 * 2. Add an entry to `SHELL_VARIANTS` below.
 *
 * That is the whole contract. A variant that needs a new BLOCK (something
 * that is not in the product's DOM today) belongs in `schematic.tsx` instead,
 * where the structure can be drawn rather than rearranged.
 */

export interface ShellVariant {
  readonly id: string;
  /** Short label for the switcher. */
  readonly label: string;
  /** What the variant changes, in one line. */
  readonly description: string;
  /** True when the variant renders the schematic instead of the product. */
  readonly schematic: boolean;
}

export const SHELL_VARIANTS: readonly ShellVariant[] = [
  {
    id: 'baseline',
    label: '现状',
    description: '产品当前的结构，不做任何改动。',
    schematic: false,
  },
  {
    id: 'schematic',
    label: '结构示意',
    description: '把大结构画成色块，用来讨论骨架，不看细节。',
    schematic: true,
  },
  {
    id: 'sidebar-top',
    label: '侧栏置顶',
    description: '侧栏从左边移到顶部，变成一条横向条。',
    schematic: false,
  },
  {
    id: 'panel-bottom',
    label: '面板下沉',
    description: '右侧面板改成停在对话区下方。',
    schematic: false,
  },
  {
    id: 'rail-only',
    label: '窄栏模式',
    description: '侧栏收成图标窄条，把宽度让给对话区。',
    schematic: false,
  },
];

const DEFAULT_VARIANT_ID = 'baseline';

/** Resolve the variant from a query string; unknown ids fall back. */
export function resolveShellVariant(search: string): ShellVariant {
  const id = new URLSearchParams(search).get('shell') ?? DEFAULT_VARIANT_ID;
  return SHELL_VARIANTS.find((variant) => variant.id === id) ?? SHELL_VARIANTS[0]!;
}

/** Mark the document with the variant so the stylesheet can key on it. */
export function applyShellVariant(variant: ShellVariant): void {
  document.documentElement.dataset.shellVariant = variant.id;
}
