/**
 * The two-row footer as a tree component.
 *
 * ## What changes, and what does not
 *
 * The RENDERING is unchanged: `buildFooterLines` still decides every character.
 * What changes is who knows the footer's height. Before, `TUIApp` reserved rows
 * for it in `inputChromeRows()` and the blessed region widget was sized from
 * that number; the two could drift. Now the component answers `measure()` and
 * that IS the reservation — the line-count invariant as a function of the
 * component instead of a constant next to it.
 *
 * Keeping the string renderer underneath is deliberate (plan 615 §Phase 6):
 * migrating a component to the tree and rewriting its renderer are separate
 * steps, and doing both at once would make a regression impossible to attribute.
 */

import { buildFooterLines, type FooterInput } from '../footer.js';
import type { SceneCanvas, UIComponent, Viewport } from '../core/component.js';

/** Everything the footer needs except the width, which the layout supplies. */
export type StatusBarProps = Omit<FooterInput, 'width'>;

/** Rows `buildFooterLines` always returns: the where, then the how much. */
const FOOTER_ROWS = 2;

export class StatusBar implements UIComponent<StatusBarProps> {
  readonly id: string;
  props: StatusBarProps;
  revision = 0;

  constructor(props: StatusBarProps, id = 'status') {
    this.id = id;
    this.props = props;
  }

  measure(_width: number): number {
    return FOOTER_ROWS;
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    const lines = buildFooterLines({ ...this.props, width: viewport.width });
    for (let index = 0; index < Math.min(lines.length, viewport.height); index += 1) {
      scene.writeTagged(viewport.row + index, viewport.column, lines[index] ?? '');
    }
  }
}
