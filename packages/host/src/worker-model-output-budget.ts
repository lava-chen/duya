import { findModelById, type ProviderRuntimeConfig } from '@duya/ai';

/** Resolve output independently from the model's input/context window. */
export function resolveWorkerOutputBudget(input: {
    readonly model?: string;
    readonly runtimeConfig?: ProviderRuntimeConfig;
    readonly maxTokens?: number;
}): number {
    const positive = (value: number | undefined): number | undefined =>
        value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
    const config = input.runtimeConfig;
    const model = config?.model ?? input.model;
    const ceiling = positive(config?.modelCapabilities?.maxOutputTokens)
        ?? positive(config?.modelCompat?.maxOutputTokens)
        ?? positive(model === undefined ? undefined : findModelById(model)?.maxTokens);
    const requested = positive(input.maxTokens) ?? 32_768;
    return ceiling === undefined ? requested : Math.min(requested, ceiling);
}
