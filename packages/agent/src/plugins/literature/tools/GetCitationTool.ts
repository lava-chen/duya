import { z } from 'zod'
import { BaseTool } from '../../../tool/BaseTool.js'
import type { ToolResult } from '../../../tool/types.js'
import type { ToolUseContext } from '../../../types.js'
import type { LiteratureStore } from '../storage/LiteratureStore.js'

const inputSchema = z.object({
  sourceId: z.string().min(1),
  style: z.enum(['bibtex', 'apa', 'gbt7714']).default('bibtex'),
})

export class GetCitationTool extends BaseTool {
  readonly name = 'literature:get_citation'
  readonly description = 'Get formatted citation for a literature source (bibtex, apa, or gbt7714)'
  readonly input_schema = inputSchema

  private store: LiteratureStore

  constructor(store: LiteratureStore) {
    super()
    this.store = store
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { sourceId, style } = inputSchema.parse(input)
    const source = await this.store.getSource(sourceId)

    if (!source) {
      return {
        id: `citation_${Date.now()}`,
        name: this.name,
        result: `No source found with ID: ${sourceId}`,
        error: true,
      }
    }

    const citation = this.formatCitation(source, style)

    return {
      id: sourceId,
      name: this.name,
      result: citation,
      metadata: { sourceId, style },
    }
  }

  private formatCitation(source: { id: string; title: string; authors: string[]; year?: number; venue?: string; doi?: string; bibtex?: string; citationKey?: string }, style: string): string {
    switch (style) {
      case 'bibtex':
        return source.bibtex || this.generateBibtex(source)
      case 'apa':
        return this.generateApa(source)
      case 'gbt7714':
        return this.generateGbt7714(source)
      default:
        return this.generateBibtex(source)
    }
  }

  private generateBibtex(source: { citationKey?: string; title: string; authors: string[]; year?: number; venue?: string; doi?: string }): string {
    const lastName = (source.authors[0]?.split(' ') ?? []).pop()?.toLowerCase() ?? '';
    const key = source.citationKey || lastName + (source.year || '')
    const firstAuthor = source.authors[0] || 'Unknown'
    return `@article{${key},\n  author = {${source.authors.join(' and ')}},\n  title = {${source.title}},\n  year = {${source.year || 'n.d.'}},\n  journal = {${source.venue || ''}},\n  doi = {${source.doi || ''}}\n}`
  }

  private generateApa(source: { authors: string[]; year?: number; title: string; venue?: string; doi?: string }): string {
    const authorStr = source.authors.map((a) => {
      const parts = a.split(' ')
      const lastName = parts.pop() || a
      return `${lastName}, ${parts.map((p) => p[0] + '.').join('')}`
    }).join(', ')
    return `${authorStr} (${source.year || 'n.d.'}). ${source.title}. ${source.venue || ''}. ${source.doi ? `https://doi.org/${source.doi}` : ''}`.trim()
  }

  private generateGbt7714(source: { authors: string[]; title: string; venue?: string; year?: number; doi?: string }): string {
    const authorStr = source.authors.join(', ')
    return `${authorStr}. ${source.title}[J]. ${source.venue || ''}, ${source.year || 'n.d.'}${source.doi ? `. DOI:${source.doi}` : ''}.`
  }
}