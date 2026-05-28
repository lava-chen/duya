export function getLiteraturePluginToolPromptSection(): string {
  return [
    'Literature Plugin tool use policy:',
    '',
    'Use Literature Plugin when the task involves:',
    '- importing, parsing, searching, summarizing, or citing papers',
    '- finding evidence spans from PDFs or webpages',
    '- generating paper cards, claim cards, method cards, or dataset cards',
    '- checking whether a statement is supported by a source',
    '- producing citations or bibliography entries',
    '',
    'Do not treat Literature Plugin results as long-term research memory.',
    'If a literature finding changes project state, propose a Research Memory candidate separately.',
    '',
    'Prefer structured evidence context:',
    '<LiteratureContext>',
    'Source: source_id/title/authors/year/citation_key',
    'Relevant Evidence: span_id/page/section/quote/summary',
    '</LiteratureContext>',
  ].join('\n')
}

