/** Compatibility registry surface while legacy Agent callers migrate. */
import { ModeModifierRegistry } from '@duya/host/worker-modes/modifiers/registry';

export { ModeModifierRegistry };

/** The Agent compatibility assembly registers its adapters in modes/index.ts. */
export const modeModifierRegistry = new ModeModifierRegistry();
