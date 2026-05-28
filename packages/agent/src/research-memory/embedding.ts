const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no', 'nor',
  'so', 'if', 'then', 'than', 'too', 'very', 'just', 'about', 'above',
  'after', 'again', 'all', 'also', 'any', 'as', 'because', 'before',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'into', 'over', 'under', 'up', 'out', 'off', 'down',
  'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they',
  'them', 'we', 'you', 'i', 'me', 'my', 'your', 'his', 'her', 'our',
  'their', 'here', 'there', 'where', 'when', 'what', 'which', 'who',
  'whom', 'how', 'why', 'while', 'during', 'through', 'between',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

function buildVocabulary(documents: string[][]): Map<string, number> {
  const df = new Map<string, number>()
  for (const doc of documents) {
    const seen = new Set(doc)
    for (const term of seen) {
      df.set(term, (df.get(term) || 0) + 1)
    }
  }
  return df
}

function tfidfVectorize(
  doc: string[],
  vocabulary: Map<string, number>,
  docCount: number,
): number[] {
  const termFreq = new Map<string, number>()
  for (const term of doc) {
    termFreq.set(term, (termFreq.get(term) || 0) + 1)
  }

  const vector: number[] = []
  for (const [term] of vocabulary) {
    const tf = (termFreq.get(term) || 0) / (doc.length || 1)
    const df = vocabulary.get(term) || 1
    const idf = Math.log((docCount + 1) / (df + 1)) + 1
    vector.push(tf * idf)
  }
  return vector
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0
  return dotProduct / denominator
}

export function computeTFIDFVector(text: string, corpus: string[]): number[] {
  const allDocs = corpus.map((c) => tokenize(c))
  const targetDoc = tokenize(text)
  allDocs.push(targetDoc)
  const vocabulary = buildVocabulary(allDocs)
  return tfidfVectorize(targetDoc, vocabulary, allDocs.length)
}

export function computeTFIDFVectorsForCorpus(texts: string[]): number[][] {
  const allDocs = texts.map((t) => tokenize(t))
  const vocabulary = buildVocabulary(allDocs)
  return allDocs.map((doc) => tfidfVectorize(doc, vocabulary, allDocs.length))
}

export function searchByEmbedding(
  queryEmbedding: number[],
  candidates: Array<{ id: string; embedding: number[] }>,
  topK: number = 10,
  minSimilarity: number = 0.3,
): Array<{ id: string; similarity: number }> {
  return candidates
    .map((c) => ({
      id: c.id,
      similarity: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .filter((r) => r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
}

export function serializeEmbedding(embedding: number[]): string {
  return JSON.stringify(embedding)
}

export function deserializeEmbedding(json: string | null | undefined): number[] | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'number')) {
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

export type EmbeddingProvider = (text: string) => Promise<number[]>

export function createTFIDFProvider(corpusTexts: string[]): EmbeddingProvider {
  const allDocs = corpusTexts.map((t) => tokenize(t))
  const vocabulary = buildVocabulary(allDocs)
  const docCount = allDocs.length

  return async (text: string): Promise<number[]> => {
    const doc = tokenize(text)
    return tfidfVectorize(doc, vocabulary, docCount)
  }
}