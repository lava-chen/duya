export function describePromptLanguage(language: string): string {
  const normalized = language.trim().toLowerCase().replace('_', '-')

  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'chinese' || normalized === 'simplified chinese') {
    return 'Simplified Chinese'
  }

  if (normalized === 'zh-tw' || normalized === 'traditional chinese') {
    return 'Traditional Chinese'
  }

  return language.trim()
}

export function buildLanguageGuidance(language: string): string {
  const displayLanguage = describePromptLanguage(language)

  return `# Language
Always respond in ${displayLanguage}.

This applies to all user-facing progress updates, final answers, explanations, and summaries. If the user writes in Chinese, the visible conversation must stay in Chinese unless you are quoting source text, code, API names, file paths, identifiers, command output, or established technical terms that should remain in their original language.`
}
