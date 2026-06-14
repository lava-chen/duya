import {
  VIZ_SPEC_PROMPT,
  VIZ_SPEC_WORKED_EXAMPLES,
} from './CanvasElementsVizSpec.js';

export {
  VIZ_SPEC_PROMPT,
  VIZ_SPEC_WORKED_EXAMPLES,
} from './CanvasElementsVizSpec.js';

export function getVizSpecSection(): string {
  return `${VIZ_SPEC_PROMPT}\n\n${VIZ_SPEC_WORKED_EXAMPLES}`;
}
