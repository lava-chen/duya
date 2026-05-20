/**
 * Conductor Agent VizSpec Section
 * Visualization specification format reference
 */

import { VIZ_SPEC_PROMPT, VIZ_SPEC_WORKED_EXAMPLES } from '../../../../conductor/CanvasElementsVizSpec.js'

export function getVizSpecSection(): string {
  return `${VIZ_SPEC_PROMPT}\n\n${VIZ_SPEC_WORKED_EXAMPLES}`
}
