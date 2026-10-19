/**
 * The question overlay as a tree component.
 *
 * ## Why this one is the second component on the tree
 *
 * The plan chose it for the harshest constraint in the system: an overlay's
 * height must match its painted rows exactly, because it is centred in the
 * alternate screen and one row of drift shifts the whole box. `measure()` here
 * is therefore derived from the SAME call that paints, so the two cannot
 * disagree — the failure mode this replaces is a `height: 7` in the region
 * patch that happens to match a seven-line question today and stops matching
 * when a question grows a description.
 *
 * ## State stays outside
 *
 * `QuestionAskState` owns selection, focus and notes. The component is a view
 * over it, re-read on every paint: `measure` and `paint` both call `render()`,
 * which is a pure function of that state. No cached lines, so no staleness —
 * and the cost is a string join on a box of at most a few dozen rows.
 */

import type { QuestionAskState, QuestionOverlayView } from '../question-overlay.js';
import type { SceneCanvas, UIComponent, Viewport } from '../core/component.js';

export interface QuestionPanelProps {
  readonly state: QuestionAskState;
  readonly view?: QuestionOverlayView;
}

export class QuestionPanel implements UIComponent<QuestionPanelProps> {
  readonly id: string;
  props: QuestionPanelProps;
  revision = 0;

  constructor(props: QuestionPanelProps, id = 'question-overlay') {
    this.id = id;
    this.props = props;
  }

  measure(_width: number): number {
    return this.lines().length;
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    const lines = this.lines();
    for (let index = 0; index < Math.min(lines.length, viewport.height); index += 1) {
      scene.writeTagged(viewport.row + index, viewport.column, lines[index] ?? '');
    }
  }

  /** The body, split into rows. One call site for measure and paint. */
  private lines(): readonly string[] {
    return this.props.state.render(this.props.view ?? { queueDepth: 0 }).split('\n');
  }
}
