"use client";

import Anthropic from "@lobehub/icons/es/Anthropic";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Zhipu from "@lobehub/icons/es/Zhipu";
import Kimi from "@lobehub/icons/es/Kimi";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Minimax from "@lobehub/icons/es/Minimax";
import Bedrock from "@lobehub/icons/es/Bedrock";
import Google from "@lobehub/icons/es/Google";
import Volcengine from "@lobehub/icons/es/Volcengine";
import Bailian from "@lobehub/icons/es/Bailian";
import Ollama from "@lobehub/icons/es/Ollama";
import LmStudio from "@lobehub/icons/es/LmStudio";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Stepfun from "@lobehub/icons/es/Stepfun";
import XAI from "@lobehub/icons/es/XAI";
import Arcee from "@lobehub/icons/es/Arcee";
import OpenAI from "@lobehub/icons/es/OpenAI";
import Qwen from "@lobehub/icons/es/Qwen";
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
