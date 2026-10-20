// The onboarding form state lives here, not in `OnboardingFlow.tsx`.
//
// `OnboardingFlow` value-imports each step component, and the config step
// needs the state shape it edits. Declaring the shape in `OnboardingFlow`
// made the step import its own owner back, which is a cycle.
//
// This module is the lower layer. It holds no behavior, so the flow and its
// steps can both depend on it without depending on each other.

import type { Locale } from "@/i18n";
import type { QuickPreset } from "@/lib/provider-presets";

export interface OnboardingState {
  locale: Locale;
  selectedPreset: QuickPreset | null;
  apiKey: string;
  selectedModel: string;
  selectedModels: string[];
}
