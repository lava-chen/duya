/**
 * cua/kindMap.ts — UIA ControlType → normalized kind vocabulary.
 *
 * Ported from the ZCode/Codex CONTROL_TYPE_TO_KIND table (plan 575):
 * buttons collapse to `button`, menus to `menuitem`, rows to `row`, and
 * containers map to "" (they are kept only as structure, never as click
 * targets). The ZCode table operates on AX role strings whose values are
 * identical to the UIA ControlType.ProgrammaticName suffixes the duya
 * probe emits ("Button", "Edit", ...), so the mapping is verbatim.
 */

export const CONTROL_TYPE_TO_KIND: Readonly<Record<string, string>> = Object.freeze({
  // Buttons (all collapse to button).
  Button: 'button',
  SplitButton: 'button',
  // Menus (all collapse to menuitem).
  MenuItem: 'menuitem',
  Menu: 'menuitem',
  MenuBar: 'menuitem',
  // Text entry.
  Edit: 'textfield',
  Document: 'textarea',
  Password: 'securefield',
  // Selection / dropdowns.
  ComboBox: 'combobox',
  CheckBox: 'checkbox',
  RadioButton: 'radio',
  // Navigation.
  Hyperlink: 'link',
  // Range / progress.
  Slider: 'slider',
  ProgressBar: 'slider',
  // Static content.
  Text: 'text',
  StatusBar: 'text',
  Image: 'image',
  // Rows (selectable items in List/Tree/DataGrid).
  ListItem: 'row',
  DataItem: 'row',
  TreeItem: 'row',
  // Tabs.
  TabItem: 'tab',
  // Unknown — excluded from re-resolution ("" is special for the ledger).
  Custom: '',
  // Containers — not actionable themselves; their children are.
  Pane: '',
  Window: '',
  Group: '',
});

/** Text-entry kinds (setValue/select_text candidates). */
export const TEXT_ENTRY_KINDS: ReadonlySet<string> = new Set([
  'textfield',
  'textarea',
  'securefield',
  'combobox',
]);

/** Map a probe ControlType to the normalized kind ("" when unknown). */
export function uiaControlTypeToKind(controlType: string | null | undefined): string {
  if (!controlType) return '';
  return CONTROL_TYPE_TO_KIND[controlType] ?? '';
}
