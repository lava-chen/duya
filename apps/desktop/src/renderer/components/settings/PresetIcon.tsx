"use client";

// Import each brand mark's `Mono` module directly instead of the package
// entry point. `@lobehub/icons/es/<Name>` is a barrel that eagerly re-exports
// `.Text` and `.Avatar`; `Avatar` pulls in `features/IconAvatar`, which imports
// the whole `@lobehub/ui` barrel for a single `Center` primitive. `@lobehub/ui`
// then ships a package.json-less `es/node_modules/@base-ui/react` shadow tree
// that shadows the hoisted `@base-ui/react`, and the bare
// `@base-ui/react/merge-props` specifier inside it stops resolving — killing
// every suite that transitively renders this component at collection time.
// `Mono` is the default export of all 18 entries, so the rendered output is
// unchanged; this only drops the unused Avatar/Text edges.
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Mono";
import Zhipu from "@lobehub/icons/es/Zhipu/components/Mono";
import Kimi from "@lobehub/icons/es/Kimi/components/Mono";
import Moonshot from "@lobehub/icons/es/Moonshot/components/Mono";
import Minimax from "@lobehub/icons/es/Minimax/components/Mono";
import Bedrock from "@lobehub/icons/es/Bedrock/components/Mono";
import Google from "@lobehub/icons/es/Google/components/Mono";
import Volcengine from "@lobehub/icons/es/Volcengine/components/Mono";
import Bailian from "@lobehub/icons/es/Bailian/components/Mono";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import LmStudio from "@lobehub/icons/es/LmStudio/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Mono";
import Stepfun from "@lobehub/icons/es/Stepfun/components/Mono";
import XAI from "@lobehub/icons/es/XAI/components/Mono";
import Arcee from "@lobehub/icons/es/Arcee/components/Mono";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Qwen from "@lobehub/icons/es/Qwen/components/Mono";
import { GlobeIcon, ServerIcon } from "@/components/icons";

interface PresetIconProps {
  iconKey: string;
  size?: number;
  className?: string;
}

// Brand marks come from @lobehub/icons: they render with currentColor, so they
// follow the active theme. Hand-rolled simple-icons SVG was dropped because its
// paths carry no fill (always black) and several providers shared placeholder
// shapes that did not match the brand at all.
export function PresetIcon({ iconKey, size = 18, className }: PresetIconProps) {
  const iconProps = { size, className };

  switch (iconKey) {
    case "anthropic":
      return <Anthropic {...iconProps} />;
    case "openrouter":
      return <OpenRouter {...iconProps} />;
    case "zhipu":
      return <Zhipu {...iconProps} />;
    case "kimi":
      return <Kimi {...iconProps} />;
    case "moonshot":
      return <Moonshot {...iconProps} />;
    case "minimax":
      return <Minimax {...iconProps} />;
    case "bedrock":
      return <Bedrock {...iconProps} />;
    case "google":
      return <Google {...iconProps} />;
    case "volcengine":
      return <Volcengine {...iconProps} />;
    case "bailian":
      return <Bailian {...iconProps} />;
    case "ollama":
      return <Ollama {...iconProps} />;
    case "lm-studio":
      return <LmStudio {...iconProps} />;
    case "deepseek":
      return <DeepSeek {...iconProps} />;
    case "stepfun":
      return <Stepfun {...iconProps} />;
    case "xai":
      return <XAI {...iconProps} />;
    case "arcee":
      return <Arcee {...iconProps} />;
    case "openai":
      return <OpenAI {...iconProps} />;
    case "qwen":
      return <Qwen {...iconProps} />;
    case "server":
      return <ServerIcon size={size} className={className ?? "text-muted-foreground"} />;
    default:
      return <GlobeIcon size={size} className={className ?? "text-muted-foreground"} />;
  }
}
