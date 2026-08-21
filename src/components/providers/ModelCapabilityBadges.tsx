/**
 * src/components/providers/ModelCapabilityBadges.tsx
 *
 * Tiny pill component that renders the LM Studio / `models-api`
 * capability flags as compact badges. Used by:
 *
 *   - `ProviderEditView` model list (settings)
 *   - `ModelInputWithFetch` dropdown options (settings)
 *   - `ModelSelector` chat input dropdown
 *
 * Each flag maps to one icon + label:
 *   vision     → EyeIcon      "vision"
 *   tool-use   → WrenchIcon   "tool-use"
 *   reasoning  → BrainIcon    "reasoning"
 *
 * If a model has no capability info (e.g. plain OpenAI `/v1/models`
 * which only returns `id`), the component renders nothing \u2014 callers
 * do not need to gate on `hasAny`. This makes the badges safe to drop
 * into any model list with no preconditions.
 *
 * The `format` flag (e.g. `'gguf'`, `'mlx'`) is rendered as a
 * separate small uppercase pill so it doesn't compete visually with
 * the capability icons.
 */
import {
  BrainIcon,
  EyeIcon,
  WrenchIcon,
} from '@/components/icons';
import { cn } from '@/lib/utils';

export interface ModelCapabilityBadgesProps {
  /** `true` when the model accepts image input. */
  vision?: boolean;
  /** `true` when the model is trained for function/tool calling. */
  toolUse?: boolean;
  /** `true` when the model emits a reasoning/thinking stream. */
  reasoning?: boolean;
  /**
   * Model quantization family (e.g. `'gguf'`, `'mlx'`). Rendered as
   * a tiny uppercase tag \u2014 display-only, no icon.
   */
  format?: string | null;
  /**
   * `true` when the model is currently loaded in the local runtime
   * (LM Studio `loaded_instances.length > 0`). Rendered as a small
   * green dot so the user can tell "this model is hot and ready" from
   * "this is a known model that the user has to load first".
   */
  isLoaded?: boolean;
  /** Layout: 'inline' for chat dropdown rows, 'block' for settings list rows. */
  variant?: 'inline' | 'block';
  /** Optional className passthrough for spacing. */
  className?: string;
}

interface BadgeSpec {
  key: string;
  label: string;
  title: string;
  bgClass: string;
  textClass: string;
  Icon: typeof EyeIcon;
}

const CAPABILITY_BADGES: readonly BadgeSpec[] = [
  {
    key: 'vision',
    label: 'vision',
    title: 'Accepts image input (LM Studio `capabilities.vision`)',
    bgClass: 'bg-blue-500/10',
    textClass: 'text-blue-700 dark:text-blue-300',
    Icon: EyeIcon,
  },
  {
    key: 'tool-use',
    label: 'tool-use',
    title: 'Trained for function/tool calling (LM Studio `capabilities.trained_for_tool_use`)',
    bgClass: 'bg-amber-500/10',
    textClass: 'text-amber-700 dark:text-amber-300',
    Icon: WrenchIcon,
  },
  {
    key: 'reasoning',
    label: 'reasoning',
    title: 'Emits reasoning/thinking stream (LM Studio `capabilities.reasoning`)',
    bgClass: 'bg-purple-500/10',
    textClass: 'text-purple-700 dark:text-purple-300',
    Icon: BrainIcon,
  },
];

export function ModelCapabilityBadges({
  vision,
  toolUse,
  reasoning,
  format,
  isLoaded,
  variant = 'inline',
  className,
}: ModelCapabilityBadgesProps) {
  const flags: Record<string, boolean | undefined> = {
    vision,
    'tool-use': toolUse,
    reasoning,
  };
  const visible = CAPABILITY_BADGES.filter((b) => flags[b.key] === true);
  const hasFormat = typeof format === 'string' && format.length > 0;

  if (visible.length === 0 && !hasFormat && !isLoaded) return null;

  const containerClass =
    variant === 'inline'
      ? 'inline-flex items-center gap-1 shrink-0'
      : 'flex items-center gap-1 flex-wrap';

  return (
    <span
      className={containerClass + (className ? ` ${className}` : '')}
      data-testid="model-capability-badges"
    >
      {visible.map((b) => {
        const Icon = b.Icon;
        const size = variant === 'inline' ? 10 : 11;
        return (
          <span
            key={b.key}
            title={b.title}
            data-testid={`model-cap-badge-${b.key}`}
            className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${b.bgClass} ${b.textClass}`}
          >
            <Icon size={size} />
            <span>{b.label}</span>
          </span>
        );
      })}
      {hasFormat && (
        <span
          title={`Model format: ${format}`}
          data-testid="model-cap-badge-format"
          className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wide bg-muted text-muted-foreground"
        >
          {format}
        </span>
      )}
      {isLoaded === true && (
        <span
          title="Model is currently loaded in the local runtime (LM Studio / Ollama)"
          data-testid="model-cap-badge-loaded"
          aria-label="loaded"
          className={cn(
            'inline-block rounded-full shrink-0',
            'bg-emerald-500',
            variant === 'inline' ? 'h-1.5 w-1.5' : 'h-2 w-2',
          )}
        />
      )}
    </span>
  );
}