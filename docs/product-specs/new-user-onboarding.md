# New User Onboarding

> Design document for DUYA's first-time user experience.

## Overview

The onboarding flow is a **3-step wizard** designed to get users up and running with DUYA in under 2 minutes. It replaces the previous 5-step flow with a more streamlined, modern experience.

## Goals

1. **Reduce friction** - Get users to their first AI interaction quickly
2. **Minimize steps** - 3 steps instead of 5 (Welcome → Config → Complete)
3. **Modern design** - Clean, card-based UI with smooth transitions
4. **Clear value proposition** - Show what DUYA can do before asking for configuration

## User Journey

### Step 1: Welcome

**Purpose**: Introduce DUYA and let users select their language

**Content**:
- Hero section with DUYA logo and tagline
- Language selector (English / 中文) - integrated into welcome step
- 3 feature cards showcasing key benefits:
  - Smart Coding - AI-powered code assistance
  - Fast & Efficient - Streamlined workflows
  - Privacy First - Local-first architecture

**Actions**:
- Select language (immediately applies)
- Click "Get Started" to proceed

### Step 2: Configuration

**Purpose**: Connect AI provider and enter API key

**Content**:
- Provider selection organized by category:
  - **Popular**: Anthropic, OpenRouter
  - **China Region**: GLM, Kimi, Moonshot, MiniMax, Volcengine, Aliyun Bailian
  - **Self-hosted**: Ollama, Third-party APIs
- Each provider shows:
  - Icon and name
  - Billing model badge (Free, Pay as you go, Coding Plan, etc.)
  - Description
- API key input with:
  - Show/hide toggle
  - Link to get API key
  - Privacy notice

**Actions**:
- Select provider
- Enter API key
- Click "Connect" to validate and save

### Step 3: Complete

**Purpose**: Celebrate completion and provide quick tips

**Content**:
- Success animation with checkmark
- "You're All Set!" message
- 3 quick tips cards:
  - Start a Conversation
  - Open a Project
  - Use Slash Commands

**Actions**:
- Click "Start Using DUYA" to close onboarding

## Technical Implementation

### File Structure

```
src/components/onboarding/
├── OnboardingFlow.tsx      # Main flow controller
└── steps/
    ├── WelcomeStep.tsx     # Step 1: Welcome + language
    ├── ConfigStep.tsx      # Step 2: Provider + API key
    └── CompleteStep.tsx    # Step 3: Success + tips
```

### State Management

```typescript
interface OnboardingState {
  locale: Locale;                    // Selected language
  selectedPreset: QuickPreset | null; // AI provider
  customName: string;                // Custom provider name
  apiKey: string;                    // API key
}
```

### Key Features

1. **Progress Indicator**: Dot-based progress bar at top
2. **Skip Option**: Users can skip onboarding at any time (except final step)
3. **Auto-detect**: If providers already configured, onboarding auto-skips
4. **Validation**: Real-time API key validation on connect
5. **Persistence**: Completion status stored in localStorage

### Styling

- Uses CSS variables from `globals.css`
- Card-based layout with rounded corners (rounded-2xl)
- Accent color for primary actions
- Smooth transitions between steps

## i18n Keys

### Flow
- `onboarding.stepWelcome` - "Welcome"
- `onboarding.stepConfig` - "Configuration"
- `onboarding.stepComplete` - "Complete"
- `onboarding.stepOf` - "Step {current} of {total}"
- `onboarding.skip` - "Skip"
- `onboarding.getStarted` - "Get Started"
- `onboarding.connect` - "Connect"
- `onboarding.connecting` - "Connecting..."

### Welcome Step
- `onboarding.welcomeTitle` - "Welcome to DUYA"
- `onboarding.welcomeDesc` - Description text
- `onboarding.featureCode.title/desc` - Smart Coding feature
- `onboarding.featureSpeed.title/desc` - Fast & Efficient feature
- `onboarding.featurePrivacy.title/desc` - Privacy First feature

### Config Step
- `onboarding.configTitle` - "Connect Your AI Provider"
- `onboarding.configDesc` - Description text
- `onboarding.getApiKey` - "Get API Key"
- `onboarding.apiKeyLabel` - "API Key"
- `onboarding.apiKeyPlaceholder` - Placeholder text
- `onboarding.privacyNotice` - Privacy explanation
- `onboarding.localProvider` - "Local / Self-hosted"

### Complete Step
- `onboarding.completeTitle` - "You're All Set!"
- `onboarding.completeDesc` - Description text
- `onboarding.quickTips` - "Quick Tips"
- `onboarding.startUsing` - "Start Using DUYA"
- `onboarding.tipChat.title/desc` - Chat tip
- `onboarding.tipProject.title/desc` - Project tip
- `onboarding.tipCommand.title/desc` - Commands tip

## Provider Billing Models

Displayed as badges on provider cards:

- `provider.free` - "Free"
- `provider.payAsYouGo` - "Pay as you go"
- `provider.codingPlan` - "Coding Plan"
- `provider.tokenPlan` - "Token Plan"
- `provider.selfHosted` - "Self-hosted"

## Comparison with Previous Design

| Aspect | Old (5-step) | New (3-step) |
|--------|-------------|--------------|
| Steps | Language → Welcome → Provider → API Key → Summary | Welcome → Config → Complete |
| Language selection | Separate step | Integrated into Welcome |
| Provider selection | Separate step | Combined with API key input |
| Summary step | Separate review step | Removed (simpler flow) |
| Visual design | Basic cards | Modern card-based UI |
| Progress indicator | Bar with segments | Dot-based with connecting lines |

## Future Enhancements

Potential improvements for future iterations:

1. **Demo mode** - Allow users to try DUYA with a sandbox environment before configuring
2. **Provider recommendations** - Suggest providers based on user's location
3. **API key validation** - Real-time validation as user types
4. **Video tutorials** - Embed short videos in tips section
5. **Keyboard shortcuts** - Show common shortcuts in complete step
