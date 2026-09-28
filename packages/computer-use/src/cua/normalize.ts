/**
 * cua/normalize.ts — accessibility-tree normalization.
 *
 * Port of the Codex/ZCode normalization pipeline (plan 575): prune
 * non-descriptive nodes, merge runs of text-only siblings, flatten
 * single-child chains of anonymous containers. Codex stages that duya
 * has NOT ported (associateTitleUIElements, flattenIntoSelectableAncestor,
 * …) are tracked in plan 575 §1 and intentionally absent.
 *
 * The trio operates on tree-shaped nodes. The duya probe currently
 * emits a flat interactive-only list (plan 562), so `adaptEnumerated`
 * is the production entry: it derives kind/pressable/hasMenu/actions
 * from the ControlType and drops nothing (the probe whitelist already
 * filtered non-interactive nodes). The tree path is kept for the
 * moment the probe emits hierarchy (plan 575 §3 Phase 2 note).
 */

import { uiaControlTypeToKind } from './kindMap.js';

/** Tree-shaped input node (superset of what the probe may one day emit). */
export interface CuaTreeNode {
  role: string;
  title?: string | null;
  description?: string | null;
  value?: string | null;
  actions?: string[];
  editable?: boolean;
  focused?: boolean;
  hasMenu?: boolean;
  children?: CuaTreeNode[];
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInteractiveLike(node: CuaTreeNode): boolean {
  return (
    (node.actions?.length ?? 0) > 0 ||
    node.editable === true ||
    node.focused === true ||
    node.hasMenu === true
  );
}

function hasDescriptiveAttributes(node: CuaTreeNode): boolean {
  return (
    nonEmpty(node.title) ||
    nonEmpty(node.description) ||
    nonEmpty(node.value) ||
    node.role === 'Image'
  );
}

function subtreeHasDescriptiveAttributes(node: CuaTreeNode): boolean {
  if (hasDescriptiveAttributes(node)) return true;
  return (node.children ?? []).some(subtreeHasDescriptiveAttributes);
}

function subtreeHasInteractive(node: CuaTreeNode): boolean {
  if (isInteractiveLike(node)) return true;
  return (node.children ?? []).some(subtreeHasInteractive);
}

function isTextOnly(node: CuaTreeNode): boolean {
  return node.role === 'Text' && !isInteractiveLike(node) && (node.children ?? []).length === 0;
}

/** Interactive shred without identity — absorbed into text runs. */
function isAbsorbableShred(node: CuaTreeNode): boolean {
  return (
    (node.role === 'Button' || node.role === 'Image') &&
    !nonEmpty(node.title) &&
    !nonEmpty(node.description) &&
    !nonEmpty(node.value) &&
    isInteractiveLike(node) &&
    (node.children ?? []).length === 0
  );
}

function textRunSeparator(role: string): string {
  if (role === 'Text') return ' ';
  if (role === 'RadioButton' || role === 'ListItem') return '; ';
  return ' ';
}

function withChildren<T>(node: T, children: T[] | undefined): T {
  if (children && children.length > 0) {
    return Object.assign({}, node, { children });
  }
  const clone = Object.assign({}, node);
  delete (clone as { children?: unknown }).children;
  return clone;
}

/** Stage 1/4: drop nodes that are neither interactive nor descriptive. */
function pruneNonDescriptive(nodes: CuaTreeNode[]): CuaTreeNode[] {
  const out: CuaTreeNode[] = [];
  for (const node of nodes) {
    const children = node.children ? pruneNonDescriptive(node.children) : undefined;
    const keep =
      isInteractiveLike(node) ||
      subtreeHasDescriptiveAttributes({ ...node, children }) ||
      // Codex predicate-chain fallback: keep a container whose subtree
      // has any interactive descendant (it may be pure layout above one).
      (children ?? []).some(subtreeHasInteractive);
    if (!keep) continue;
    out.push(withChildren(node, children));
  }
  return out;
}

/** Stage 2: merge sibling runs of text-only / absorbable shreds. */
function mergeTextOnlySiblings(nodes: CuaTreeNode[]): CuaTreeNode[] {
  const out: CuaTreeNode[] = [];
  let run: CuaTreeNode[] = [];
  const flushRun = () => {
    const head = run[0];
    if (!head) {
      run = [];
      return;
    }
    if (run.length === 1) {
      out.push(head);
    } else {
      const separator = textRunSeparator(head.role);
      const mergedTitle = run
        .map((n) => (isTextOnly(n) ? n.title ?? n.value ?? '' : ''))
        .filter((part) => part.length > 0)
        .join(separator);
      out.push({ ...head, title: mergedTitle, value: null });
    }
    run = [];
  };
  for (const node of nodes) {
    if (isTextOnly(node) || isAbsorbableShred(node)) {
      run.push(node);
      continue;
    }
    flushRun();
    out.push(
      withChildren(
        node,
        node.children?.length ? mergeTextOnlySiblings(node.children) : undefined,
      ),
    );
  }
  flushRun();
  return out;
}

/** Stage 3: flatten chains of anonymous single-child containers. */
function flattenRedundantHierarchy(nodes: CuaTreeNode[]): CuaTreeNode[] {
  const out: CuaTreeNode[] = [];
  for (const node of nodes) {
    let current = node;
    for (
      let guard = 0;
      guard < 16 &&
      !hasDescriptiveAttributes(current) &&
      !isInteractiveLike(current) &&
      (current.children?.length ?? 0) === 1;
      guard += 1
    ) {
      const next = current.children?.[0];
      if (!next) break;
      current = next;
    }
    out.push(
      withChildren(
        current,
        current.children?.length ? flattenRedundantHierarchy(current.children) : undefined,
      ),
    );
  }
  return out;
}

/** Full pipeline: prune → merge → flatten → prune. */
export function normalizeAxTree(roots: CuaTreeNode[]): CuaTreeNode[] {
  let tree: CuaTreeNode[] = roots.map((node) => ({ ...node, children: node.children?.slice() }));
  tree = pruneNonDescriptive(tree);
  tree = mergeTextOnlySiblings(tree);
  tree = flattenRedundantHierarchy(tree);
  tree = pruneNonDescriptive(tree);
  return tree;
}

// ────────────────────────────────────────────────────────────────────
// Flat adaptation (production path for the plan 562 probe list)
// ────────────────────────────────────────────────────────────────────

/** Raw enumerated element as the probe reports it (subset used here). */
export interface EnumeratedProbeElement {
  name?: string | null;
  controlType?: string | null;
  automationId?: string | null;
  className?: string | null;
  rect?: { x: number; y: number; w: number; h: number } | null;
  isPassword?: boolean | null;
  value?: string | null;
  interactive?: boolean;
  /** Real UIA state (plan 575 probe upgrade): absent = unknown. */
  enabled?: boolean;
  focused?: boolean;
  /** Emitted only when the element carries SelectionItemPattern. */
  selected?: boolean;
}

/** Semantic actions derived from a ControlType (aligned AX vocabulary). */
export function deriveActions(controlType: string | null | undefined): string[] {
  switch (controlType) {
    case 'Button':
    case 'Hyperlink':
    case 'ListItem':
    case 'DataItem':
    case 'TreeItem':
    case 'TabItem':
      return ['AXPress'];
    case 'CheckBox':
      return ['AXPress', 'AXToggle'];
    case 'RadioButton':
      return ['AXSelect'];
    case 'ComboBox':
      return ['AXExpand', 'AXPress'];
    case 'Edit':
    case 'Document':
      return ['AXSetValue'];
    case 'Slider':
      return ['AXSetValue', 'AXIncrement', 'AXDecrement'];
    case 'Menu':
      return ['AXShowMenu', 'AXPress'];
    default:
      return [];
  }
}

/**
 * Adapt one flat probe element into the CUA element shape. `probeIndex`
 * is the 1-based enumerate emission order (the probe's cache slot for
 * the invoke path); `hwnd` and `token` come from the caller (service).
 */
export function adaptEnumerated(
  el: EnumeratedProbeElement,
  probeIndex: number,
  hwnd: number,
  ownerPid: number | null,
): {
  role: string;
  kind: string;
  title: string | null;
  value: string | null;
  bounds: [number, number, number, number];
  enabled: boolean;
  focused: boolean;
  editable: boolean;
  actions: string[];
  pressable: boolean;
  hasMenu: boolean;
  selected?: boolean;
  ownerPid: number | null;
  probeIndex: number;
  hwnd: number;
} {
  const kind = uiaControlTypeToKind(el.controlType);
  const actions = deriveActions(el.controlType);
  const r = el.rect;
  return {
    role: el.controlType ?? '',
    kind,
    title: el.name ?? null,
    value: el.isPassword === true ? null : (el.value ?? null),
    bounds: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)] : [0, 0, 0, 0],
    // Real UIA state when the probe reports it; the previous constants
    // (true/false) remain the fallback for an older probe binary.
    enabled: el.enabled ?? true,
    focused: el.focused ?? false,
    selected: el.selected ?? false,
    editable:
      el.controlType === 'Edit' ||
      el.controlType === 'Document' ||
      el.controlType === 'ComboBox',
    actions,
    pressable: actions.includes('AXPress'),
    hasMenu: actions.includes('AXShowMenu'),
    ownerPid,
    probeIndex,
    hwnd,
  };
}
