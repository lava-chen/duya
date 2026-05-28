export function getEvidencePolicyPromptSection(): string {
  return [
    'Evidence policy:',
    'A research claim is source-backed only if it is supported by Literature Plugin evidence spans, Research Memory evidence links, or user-provided materials.',
    '',
    'When evidence is insufficient:',
    '- say that evidence is insufficient',
    '- provide interpretation only if clearly labeled as inference',
    '- suggest what source or experiment would verify it',
    '',
    'Never fabricate: paper titles, authors, venues, years, DOI, datasets, metrics, experimental results, citations.',
  ].join('\n')
}

