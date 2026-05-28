import { LiteratureStore } from './storage/LiteratureStore.js'
import { AddSourceTool } from './tools/AddSourceTool.js'
import { SearchSourcesTool } from './tools/SearchSourcesTool.js'
import { SearchEvidenceTool } from './tools/SearchEvidenceTool.js'
import { GetCitationTool } from './tools/GetCitationTool.js'
import { ExtractPaperCardTool } from './tools/ExtractPaperCardTool.js'
import type { BaseTool } from '../../tool/BaseTool.js'
import type { LiteraturePluginRuntime } from './types.js'
import type { LiteratureSource, EvidenceSpan, PaperCardRecord, AddSourceInput } from './types.js'

export class LiteraturePlugin implements LiteraturePluginRuntime {
  private store: LiteratureStore

  readonly addSourceTool: AddSourceTool
  readonly searchSourcesTool: SearchSourcesTool
  readonly searchEvidenceTool: SearchEvidenceTool
  readonly getCitationTool: GetCitationTool
  readonly extractPaperCardTool: ExtractPaperCardTool

  constructor() {
    this.store = new LiteratureStore()
    this.addSourceTool = new AddSourceTool(this.store)
    this.searchSourcesTool = new SearchSourcesTool(this.store)
    this.searchEvidenceTool = new SearchEvidenceTool(this.store)
    this.getCitationTool = new GetCitationTool(this.store)
    this.extractPaperCardTool = new ExtractPaperCardTool(this.store)
  }

  get tools(): BaseTool[] {
    return [
      this.addSourceTool,
      this.searchSourcesTool,
      this.searchEvidenceTool,
      this.getCitationTool,
      this.extractPaperCardTool,
    ]
  }

  async addSource(input: AddSourceInput): Promise<LiteratureSource> {
    return this.store.createSource(input)
  }

  async searchSources(query: string, options?: Parameters<LiteratureStore['listSources']>[0]): Promise<LiteratureSource[]> {
    return this.store.listSources({ search: query, ...options })
  }

  async searchEvidence(query: string, options?: Parameters<LiteratureStore['searchEvidence']>[1]): Promise<EvidenceSpan[]> {
    return this.store.searchEvidence(query, options)
  }

  async getCitation(sourceId: string, style: 'bibtex' | 'apa' | 'gbt7714'): Promise<string> {
    const source = await this.store.getSource(sourceId)
    if (!source) throw new Error(`Source not found: ${sourceId}`)
    if (style === 'bibtex' && source.bibtex) return source.bibtex
    return `Citation for ${source.title} (${style})`
  }

  async extractPaperCard(sourceId: string): Promise<PaperCardRecord> {
    const existing = await this.store.getPaperCard(sourceId)
    if (existing) return existing
    throw new Error(`No paper card found for source: ${sourceId}. Use literature:extract_paper_card tool first.`)
  }
}