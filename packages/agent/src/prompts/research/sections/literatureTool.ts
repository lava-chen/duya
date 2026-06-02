export function getLiteraturePluginToolPromptSection(): string {
  return [
    'Literature MCP Tools (literature server):',
    '',
    'The Literature Plugin provides these tools via MCP for managing research sources and evidence.',
    'Use them when the task involves:',
    '- storing, searching, or citing papers, books, and other sources',
    '- finding evidence spans from stored sources',
    '- extracting structured paper cards (problem, method, findings, etc.)',
    '- formatting citations in bibtex, APA, or GB/T 7714',
    '',
    'Available tools:',
    '- literature:add_source     — add a paper, book, webpage, report, thesis, or dataset',
    '- literature:search_sources — search by title, DOI, kind, year range, or tags',
    '- literature:search_evidence — search within stored evidence spans',
    '- literature:get_citation   — format a citation in bibtex, apa, or gbt7714 style',
    '- literature:extract_paper_card — extract/update a structured paper card for a source',
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

