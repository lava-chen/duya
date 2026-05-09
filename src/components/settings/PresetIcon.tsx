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
import { GlobeIcon, ServerIcon } from "@/components/icons";

interface PresetIconProps {
  iconKey: string;
  size?: number;
}

export function PresetIcon({ iconKey, size = 18 }: PresetIconProps) {
  const iconProps = { size };

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
    case "server":
      return <ServerIcon size={size} className="text-muted-foreground" />;
    default:
      return <GlobeIcon size={size} className="text-muted-foreground" />;
  }
}
