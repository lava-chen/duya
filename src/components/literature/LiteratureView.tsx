"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  LiteratureCitationStyle,
  LiteratureDocumentChunk,
  LiteratureEvidenceSummary,
  LiteraturePaperCardSummary,
  LiteratureSourceSummary,
} from "../../../electron/preload";
import {
  getLiteratureCitation,
  getLiteraturePaperCard,
  getLiteratureSource,
  ingestParsedLiteratureDocument,
  listLiteratureChunks,
  listLiteratureEvidence,
  listLiteratureSources,
  saveLiteratureEvidence,
} from "@/lib/literature-ipc";

type ImportResultState =
  | { status: "idle" }
  | { status: "parsing"; filename: string }
  | { status: "saving"; filename: string }
  | { status: "success"; action: "created" | "updated"; source: LiteratureSourceSummary }
  | { status: "error"; message: string };

type EvidenceSaveState =
  | { status: "idle" }
  | { status: "saving"; chunkId: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

function getPaperCardStatusText(paperCard: LiteraturePaperCardSummary | null): string {
  const analysisMeta = paperCard?.card.analysisMeta;
  if (!analysisMeta) {
    return "Saved card · analysis metadata unavailable";
  }
  if (analysisMeta.generatedBy === "agent" && analysisMeta.scope === "partial_context" && analysisMeta.verificationStatus === "unverified") {
    return "Agent draft · based on partial parsed text · unverified";
  }
  if (analysisMeta.generatedBy === "agent" && analysisMeta.scope === "full_context" && analysisMeta.verificationStatus === "unverified") {
    return "Agent draft · based on full parsed text · unverified";
  }
  if (analysisMeta.generatedBy === "agent" && analysisMeta.verificationStatus === "user_verified") {
    return "Agent-assisted card · user verified";
  }
  return "Saved card";
}

function getPaperCardMetaDetail(paperCard: LiteraturePaperCardSummary | null): string | null {
  const analysisMeta = paperCard?.card.analysisMeta;
  if (!analysisMeta) {
    return null;
  }
  return `${analysisMeta.analyzedChunkCount}/${analysisMeta.totalChunkCount} chunks analyzed`;
}

export function LiteratureView() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sources, setSources] = useState<LiteratureSourceSummary[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<LiteratureSourceSummary | null>(null);
  const [chunks, setChunks] = useState<LiteratureDocumentChunk[]>([]);
  const [evidence, setEvidence] = useState<LiteratureEvidenceSummary[]>([]);
  const [paperCard, setPaperCard] = useState<LiteraturePaperCardSummary | null>(null);
  const [citationStyle, setCitationStyle] = useState<LiteratureCitationStyle>("bibtex");
  const [citationText, setCitationText] = useState("");
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isLoadingCitation, setIsLoadingCitation] = useState(false);
  const [importResult, setImportResult] = useState<ImportResultState>({ status: "idle" });
  const [evidenceSaveState, setEvidenceSaveState] = useState<EvidenceSaveState>({ status: "idle" });

  const refreshSources = useCallback(async () => {
    setIsLoadingSources(true);
    try {
      const nextSources = await listLiteratureSources();
      setSources(nextSources);
      setSelectedSourceId((current) => {
        if (current && nextSources.some((source) => source.id === current)) {
          return current;
        }
        return nextSources[0]?.id ?? null;
      });
    } finally {
      setIsLoadingSources(false);
    }
  }, []);

  const refreshEvidence = useCallback(async (sourceId: string) => {
    const nextEvidence = await listLiteratureEvidence(sourceId);
    setEvidence(nextEvidence);
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  useEffect(() => {
    if (!selectedSourceId) {
      setSelectedSource(null);
      setChunks([]);
      setEvidence([]);
      setPaperCard(null);
      return;
    }

    setIsLoadingDetails(true);
    void Promise.all([
      getLiteratureSource(selectedSourceId),
      listLiteratureChunks(selectedSourceId, 24),
      getLiteraturePaperCard(selectedSourceId),
      listLiteratureEvidence(selectedSourceId),
    ])
      .then(([source, nextChunks, nextPaperCard, nextEvidence]) => {
        setSelectedSource(source);
        setChunks(nextChunks);
        setPaperCard(nextPaperCard);
        setEvidence(nextEvidence);
      })
      .finally(() => {
        setIsLoadingDetails(false);
      });
  }, [selectedSourceId]);

  useEffect(() => {
    if (!selectedSourceId) {
      setCitationText("");
      return;
    }

    setIsLoadingCitation(true);
    void getLiteratureCitation(selectedSourceId, citationStyle)
      .then((text) => {
        setCitationText(text);
      })
      .catch((error) => {
        setCitationText(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setIsLoadingCitation(false);
      });
  }, [citationStyle, selectedSourceId]);

  const handlePickPdf = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    const fileWithPath = file as File & { path?: string };
    if (!fileWithPath.path) {
      setImportResult({ status: "error", message: "This build could not access the local PDF path." });
      return;
    }

    try {
      setImportResult({ status: "parsing", filename: file.name });
      const parseResult = await window.electronAPI.parser.parse(fileWithPath.path);

      setImportResult({ status: "saving", filename: file.name });
      const result = await ingestParsedLiteratureDocument({
        filePath: fileWithPath.path,
        parseResult,
      });

      await refreshSources();
      setSelectedSourceId(result.source.id);
      setImportResult({ status: "success", action: result.action, source: result.source });
    } catch (error) {
      setImportResult({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refreshSources]);

  const handleSaveEvidence = useCallback(async (chunk: LiteratureDocumentChunk) => {
    if (!selectedSourceId) {
      return;
    }

    setEvidenceSaveState({ status: "saving", chunkId: chunk.id });
    try {
      const result = await saveLiteratureEvidence({
        sourceId: selectedSourceId,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        sectionLabel: chunk.sectionLabel,
        text: chunk.text,
        quote: chunk.text,
      });
      await refreshEvidence(selectedSourceId);
      setEvidenceSaveState({
        status: "success",
        message: result.action === "created"
          ? `Saved chunk #${chunk.chunkIndex} as formal evidence.`
          : `Chunk #${chunk.chunkIndex} was already saved as formal evidence.`,
      });
    } catch (error) {
      setEvidenceSaveState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refreshEvidence, selectedSourceId]);

  const handleCopyCitation = useCallback(async () => {
    if (!citationText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(citationText);
    } catch {
      // Ignore clipboard failures in MVP.
    }
  }, [citationText]);

  const importStatusText = useMemo(() => {
    switch (importResult.status) {
      case "parsing":
        return `Parsing ${importResult.filename}...`;
      case "saving":
        return `Saving ${importResult.filename} into Literature...`;
      case "success":
        return importResult.action === "created"
          ? `Imported as a new source: ${importResult.source.title}`
          : `Reused existing source and refreshed chunks: ${importResult.source.title}`;
      case "error":
        return importResult.message;
      default:
        return "Choose a PDF to import it into the Literature library.";
    }
  }, [importResult]);

  const evidenceStatusText = useMemo(() => {
    if (evidenceSaveState.status === "success" || evidenceSaveState.status === "error") {
      return evidenceSaveState.message;
    }
    return "Formal evidence is only created when you explicitly save a source text chunk. Exact PDF page jump is not supported in this MVP.";
  }, [evidenceSaveState]);

  const paperCardStatusText = useMemo(() => getPaperCardStatusText(paperCard), [paperCard]);
  const paperCardMetaDetail = useMemo(() => getPaperCardMetaDetail(paperCard), [paperCard]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--text)]">
      <div className="border-b border-[var(--border)] px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Literature MVP</p>
            <h1 className="text-2xl font-semibold">Library</h1>
            <p className="max-w-3xl text-sm text-[var(--muted)]">
              Import a PDF, parse its text, and keep the source plus raw chunks in the literature domain.
              Saved paper cards are shown with their analysis status, and formal evidence is only created after an explicit save action.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={handlePickPdf}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Import PDF
            </button>
          </div>
        </div>
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            importResult.status === "error"
              ? "border-[var(--error)]/40 bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]"
              : "border-[var(--border)] bg-[var(--bg-panel)] text-[var(--muted)]"
          }`}
        >
          {importStatusText}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-r border-[var(--border)] bg-[var(--bg-panel)]/60">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold">Imported Sources</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {isLoadingSources ? "Loading..." : `${sources.length} source${sources.length === 1 ? "" : "s"}`}
            </p>
          </div>

          <div className="min-h-0 overflow-y-auto">
            {sources.length === 0 && !isLoadingSources ? (
              <div className="px-4 py-6 text-sm text-[var(--muted)]">
                No PDFs imported yet.
              </div>
            ) : (
              sources.map((source) => {
                const isActive = selectedSourceId === source.id;
                return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => setSelectedSourceId(source.id)}
                    className={`w-full border-b border-[var(--border)] px-4 py-3 text-left transition-colors ${
                      isActive ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-hover)]/60"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{source.title}</p>
                        <p className="mt-1 truncate text-xs text-[var(--muted)]">
                          {source.filePath ?? "No file path"}
                        </p>
                      </div>
                      <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
                        {source.parseStatus}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-xs text-[var(--muted)]">
                      <span>{source.chunkCount} chunks</span>
                      <span>{String(source.parseMetadata.extractMethod ?? "unknown")}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto px-6 py-5">
          {!selectedSource ? (
            <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-panel)]/50 px-6 py-10 text-sm text-[var(--muted)]">
              Select an imported source to inspect the stored chunks, saved card status, evidence, and citation.
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold">{selectedSource.title}</h2>
                    <p className="text-sm text-[var(--muted)]">{selectedSource.filePath ?? "No file path stored"}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)]">
                    Parse status: <span className="font-medium text-[var(--text)]">{selectedSource.parseStatus}</span>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-[var(--border)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">File Hash</p>
                    <p className="mt-2 break-all text-sm">{selectedSource.fileHash ?? "Unavailable"}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Extract Method</p>
                    <p className="mt-2 text-sm">{String(selectedSource.parseMetadata.extractMethod ?? "unknown")}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Characters</p>
                    <p className="mt-2 text-sm">{Number(selectedSource.parseMetadata.charCount ?? 0).toLocaleString()}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Chunks</p>
                    <p className="mt-2 text-sm">{selectedSource.chunkCount}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">Saved Paper Card</h3>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      Agent-generated cards are shown with their analysis scope and verification status. A card created from partial context is a draft, not a complete paper analysis.
                    </p>
                  </div>
                </div>

                {paperCard ? (
                  <div className="mt-4 space-y-4">
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                      <p className="text-sm font-medium">{paperCardStatusText}</p>
                      {paperCardMetaDetail ? (
                        <p className="mt-1 text-xs text-[var(--muted)]">{paperCardMetaDetail}</p>
                      ) : null}
                    </div>

                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Research Problem</p>
                        <p className="mt-2 text-sm leading-6">{paperCard.card.researchProblem || "Not provided"}</p>
                      </div>
                      <div className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Method Summary</p>
                        <p className="mt-2 text-sm leading-6">{paperCard.card.methodSummary || "Not provided"}</p>
                      </div>
                    </div>

                    <div className="grid gap-3 xl:grid-cols-2">
                      <div className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Key Findings</p>
                        <ul className="mt-2 space-y-2 text-sm leading-6">
                          {paperCard.card.keyFindings.length > 0 ? (
                            paperCard.card.keyFindings.map((finding, index) => (
                              <li key={`${paperCard.id}-finding-${index}`}>{finding}</li>
                            ))
                          ) : (
                            <li className="text-[var(--muted)]">Not provided</li>
                          )}
                        </ul>
                      </div>
                      <div className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Limitations</p>
                        <ul className="mt-2 space-y-2 text-sm leading-6">
                          {paperCard.card.limitations.length > 0 ? (
                            paperCard.card.limitations.map((limitation, index) => (
                              <li key={`${paperCard.id}-limitation-${index}`}>{limitation}</li>
                            ))
                          ) : (
                            <li className="text-[var(--muted)]">Not provided</li>
                          )}
                        </ul>
                      </div>
                    </div>

                    <div className="grid gap-3 xl:grid-cols-3">
                      <div className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Datasets</p>
                        <p className="mt-2 text-sm leading-6">
                          {paperCard.card.datasets.length > 0 ? paperCard.card.datasets.join(", ") : "Not provided"}
                        </p>
                      </div>
                      <div className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Metrics</p>
                        <p className="mt-2 text-sm leading-6">
                          {paperCard.card.metrics.length > 0 ? paperCard.card.metrics.join(", ") : "Not provided"}
                        </p>
                      </div>
                      <div className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Reusable Ideas</p>
                        <p className="mt-2 text-sm leading-6">
                          {paperCard.card.reusableIdeas.length > 0 ? paperCard.card.reusableIdeas.join("; ") : "Not provided"}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--muted)]">
                    No saved paper card yet. Ask the Agent in chat or Research Mode to analyze this source and save a structured card.
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h3 className="text-base font-semibold">Citation</h3>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      Citation text is generated by the same Literature formatter used by the MCP citation tool.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(["bibtex", "apa", "gbt7714"] as LiteratureCitationStyle[]).map((style) => (
                      <button
                        key={style}
                        type="button"
                        onClick={() => setCitationStyle(style)}
                        className={`rounded-lg border px-3 py-1.5 text-sm ${
                          citationStyle === style
                            ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                            : "border-[var(--border)] text-[var(--muted)]"
                        }`}
                      >
                        {style}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={handleCopyCitation}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)]"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <pre className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-4 text-sm whitespace-pre-wrap text-[var(--text)]">
                  {isLoadingCitation ? "Loading citation..." : citationText || "No citation available."}
                </pre>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">Saved Evidence</h3>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      Formal evidence is only created when you explicitly save a source text chunk. This MVP supports tracing back to the source and chunk text, not exact PDF page jumps.
                    </p>
                  </div>
                  <span className="text-xs text-[var(--muted)]">{evidence.length} saved</span>
                </div>

                <div
                  className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
                    evidenceSaveState.status === "error"
                      ? "border-[var(--error)]/40 bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]"
                      : "border-[var(--border)] bg-[var(--bg)] text-[var(--muted)]"
                  }`}
                >
                  {evidenceStatusText}
                </div>

                <div className="mt-4 space-y-3">
                  {evidence.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--muted)]">
                      No formal evidence saved yet.
                    </div>
                  ) : (
                    evidence.map((item) => (
                      <article key={item.id} className="rounded-xl border border-[var(--border)] px-4 py-4">
                        <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                          <span>
                            {item.chunkIndex != null ? `Saved from chunk #${item.chunkIndex}` : "Saved evidence"}
                          </span>
                          <span>
                            {item.pageNumber != null ? `Page ${item.pageNumber}` : "Exact PDF page unavailable"}
                          </span>
                        </div>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--text)]">
                          {item.quote || item.text}
                        </p>
                      </article>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">Stored Text Chunks</h3>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      These chunks are the parsed source text stored for later processing. Page and section locators are reserved for future parser upgrades.
                    </p>
                  </div>
                  <span className="text-xs text-[var(--muted)]">{isLoadingDetails ? "Loading..." : `${chunks.length} shown`}</span>
                </div>

                <div className="mt-4 space-y-3">
                  {chunks.length === 0 && !isLoadingDetails ? (
                    <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--muted)]">
                      No stored chunks for this source yet.
                    </div>
                  ) : (
                    chunks.map((chunk) => {
                      const isSavingThisChunk = evidenceSaveState.status === "saving" && evidenceSaveState.chunkId === chunk.id;
                      return (
                        <article key={chunk.id} className="rounded-xl border border-[var(--border)] px-4 py-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
                              <span>Chunk #{chunk.chunkIndex}</span>
                              <span>{chunk.charCount} chars</span>
                              <span>{chunk.pageNumber != null ? `Page ${chunk.pageNumber}` : "No exact PDF page"}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleSaveEvidence(chunk)}
                              disabled={isSavingThisChunk}
                              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] disabled:opacity-60"
                            >
                              {isSavingThisChunk ? "Saving..." : "Save as Evidence"}
                            </button>
                          </div>
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--text)]">
                            {chunk.text}
                          </p>
                        </article>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
