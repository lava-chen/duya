/**
 * @deprecated Placeholder. Real implementation moved in Phase 3.
 */

export class ConductorPromptSystem {
  getName(): string {
    return 'conductor';
  }
  getStaticSections(): unknown[] {
    return [];
  }
  getDynamicSections(): unknown[] {
    return [];
  }
  async buildSystemPrompt(): Promise<{ content: string }> {
    return { content: '' };
  }
  buildContext(options: unknown): unknown {
    return options;
  }
}
