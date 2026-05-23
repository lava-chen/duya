import type { BaseMode, ModeConstructor } from './types.js';

class ModeRegistryImpl {
  private modes = new Map<string, ModeConstructor>();

  register(modeId: string, ctor: ModeConstructor): void {
    if (this.modes.has(modeId)) {
      throw new Error(`Mode "${modeId}" is already registered`);
    }
    this.modes.set(modeId, ctor);
  }

  create(modeId: string): BaseMode {
    const ctor = this.modes.get(modeId);
    if (!ctor) {
      throw new Error(
        `Mode "${modeId}" not found. Registered modes: ${[...this.modes.keys()].join(', ') || 'none'}`
      );
    }
    return new ctor();
  }

  has(modeId: string): boolean {
    return this.modes.has(modeId);
  }

  list(): string[] {
    return [...this.modes.keys()];
  }

  reset(): void {
    this.modes.clear();
  }
}

export const ModeRegistry = new ModeRegistryImpl();

export { BaseMode } from './types.js';
export type { ModeContext, ModeConstructor, ClarificationQuestion, ClarificationAnswer } from './types.js';