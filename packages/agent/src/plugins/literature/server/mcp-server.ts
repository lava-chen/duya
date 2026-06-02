import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";

function parseDbPath(): string {
  const argIdx = process.argv.indexOf("--db-path");
  if (argIdx !== -1 && argIdx + 1 < process.argv.length) {
    return process.argv[argIdx + 1];
  }
  if (process.env.DUYA_DB_PATH) {
    return process.env.DUYA_DB_PATH;
  }
  throw new Error(
    "Database path not provided. Use --db-path argument or DUYA_DB_PATH env var."
  );
}

function loadBetterSqlite3(): typeof Database {
  const customPath = process.env.DUYA_BETTER_SQLITE3_PATH;
  if (customPath) {
    const mod = require(customPath);
    return mod.default ?? mod;
  }
  return require("better-sqlite3");
}

const DatabaseCtor = loadBetterSqlite3();
const dbPath = parseDbPath();

const db = new DatabaseCtor(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

process.on("exit", () => {
  try {
    db.close();
  } catch {
    // ignore
  }
});

interface SourceRow {
  id: string;
  kind: string;
  title: string;
  authors_json: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  file_path: string | null;
  citation_key: string | null;
  bibtex: string | null;
  project_ids_json: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

interface EvidenceRow {
  id: string;
  source_id: string;
  page: number | null;
  section: string | null;
  text: string;
  quote: string | null;
  bbox_json: string | null;
  created_at: number;
}

interface PaperCardRow {
  id: string;
  source_id: string;
  card_json: string;
  evidence_span_ids_json: string;
  created_at: number;
  updated_at: number;
}

function formatSource(row: SourceRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    authors: JSON.parse(row.authors_json || "[]"),
    year: row.year ?? undefined,
    venue: row.venue ?? undefined,
    doi: row.doi ?? undefined,
    arxivId: row.arxiv_id ?? undefined,
    url: row.url ?? undefined,
    filePath: row.file_path ?? undefined,
    citationKey: row.citation_key ?? undefined,
    bibtex: row.bibtex ?? undefined,
    projectIds: JSON.parse(row.project_ids_json || "[]"),
    tags: JSON.parse(row.tags_json || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatEvidence(row: EvidenceRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    page: row.page ?? undefined,
    section: row.section ?? undefined,
    text: row.text,
    quote: row.quote ?? undefined,
    bbox: row.bbox_json ? JSON.parse(row.bbox_json) : undefined,
    createdAt: row.created_at,
  };
}

function formatPaperCard(row: PaperCardRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    card: JSON.parse(row.card_json),
    evidenceSpanIds: JSON.parse(row.evidence_span_ids_json || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatBibtex(source: SourceRow): string {
  const lastName =
    (JSON.parse(source.authors_json || "[]")[0]?.split(" ").pop()?.toLowerCase()) ?? "";
  const key = source.citation_key || lastName + (source.year || "");
  const authors = JSON.parse(source.authors_json || "[]").join(" and ") || "Unknown";
  return [
    `@article{${key},`,
    `  author = {${authors}},`,
    `  title = {${source.title}},`,
    `  year = {${source.year || "n.d."}},`,
    `  journal = {${source.venue || ""}},`,
    `  doi = {${source.doi || ""}}`,
    `}`,
  ].join("\n");
}

function formatApa(source: SourceRow): string {
  const authors: string[] = JSON.parse(source.authors_json || "[]");
  const authorStr = authors
    .map((a) => {
      const parts = a.split(" ");
      const lastName = parts.pop() || a;
      return `${lastName}, ${parts.map((p) => p[0] + ".").join("")}`;
    })
    .join(", ");
  return [
    `${authorStr} (${source.year || "n.d."}). ${source.title}.`,
    `${source.venue || ""}.`,
    source.doi ? `https://doi.org/${source.doi}` : "",
  ].join(" ");
}

function formatGbt7714(source: SourceRow): string {
  const authors = JSON.parse(source.authors_json || "[]").join(", ");
  return [
    `${authors}. ${source.title}[J].`,
    `${source.venue || ""}, ${source.year || "n.d."}`,
    source.doi ? `. DOI:${source.doi}` : "",
    ".",
  ].join("");
}

// --- MCP Server ---

const server = new McpServer({
  name: "literature",
  version: "0.1.0",
});

// 1. literature:add_source
server.registerTool(
  "literature:add_source",
  {
    title: "Add Literature Source",
    description: "Add a new literature source (paper, book, webpage, report, thesis, dataset) to the library.",
    inputSchema: {
      kind: z.enum(["paper", "book", "webpage", "report", "thesis", "dataset"]).describe("Kind of literature source"),
      title: z.string().min(1).describe("Title of the source"),
      authors: z.array(z.string()).default([]).describe("List of author names"),
      year: z.number().int().optional().describe("Publication year"),
      venue: z.string().optional().describe("Journal, conference, or publisher name"),
      doi: z.string().optional().describe("DOI identifier"),
      arxivId: z.string().optional().describe("arXiv ID"),
      url: z.string().optional().describe("URL to the source"),
      filePath: z.string().optional().describe("Local file path to the PDF"),
      citationKey: z.string().optional().describe("Citation key for BibTeX"),
      bibtex: z.string().optional().describe("Full BibTeX entry"),
      projectIds: z.array(z.string()).default([]).describe("Associated project IDs"),
      tags: z.array(z.string()).default([]).describe("User-defined tags"),
    },
  },
  async (input) => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO literature_sources (
        id, kind, title, authors_json, year, venue, doi, arxiv_id,
        url, file_path, citation_key, bibtex, project_ids_json, tags_json,
        created_at, updated_at
      ) VALUES (
        @id, @kind, @title, @authors_json, @year, @venue, @doi, @arxiv_id,
        @url, @file_path, @citation_key, @bibtex, @project_ids_json, @tags_json,
        @created_at, @updated_at
      )
    `).run({
      id,
      kind: input.kind,
      title: input.title,
      authors_json: JSON.stringify(input.authors),
      year: input.year ?? null,
      venue: input.venue ?? null,
      doi: input.doi ?? null,
      arxiv_id: input.arxivId ?? null,
      url: input.url ?? null,
      file_path: input.filePath ?? null,
      citation_key: input.citationKey ?? null,
      bibtex: input.bibtex ?? null,
      project_ids_json: JSON.stringify(input.projectIds),
      tags_json: JSON.stringify(input.tags),
      created_at: now,
      updated_at: now,
    });
    const row = db.prepare("SELECT * FROM literature_sources WHERE id = ?").get(id) as SourceRow;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(formatSource(row), null, 2) }],
    };
  }
);

// 2. literature:search_sources
server.registerTool(
  "literature:search_sources",
  {
    title: "Search Literature Sources",
    description: "Search literature sources by metadata (title, DOI, kind, year range, tags).",
    inputSchema: {
      query: z.string().min(1).describe("Search term (matches title, DOI, citation key)"),
      kind: z.enum(["paper", "book", "webpage", "report", "thesis", "dataset"]).optional().describe("Filter by source kind"),
      projectId: z.string().optional().describe("Filter by project ID"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      yearFrom: z.number().int().optional().describe("Filter by minimum year"),
      yearTo: z.number().int().optional().describe("Filter by maximum year"),
      limit: z.number().int().min(1).max(200).default(50).describe("Maximum results"),
    },
  },
  async (input) => {
    const conditions: string[] = [
      "(title LIKE @search OR doi LIKE @search OR citation_key LIKE @search)",
    ];
    const params: Record<string, unknown> = {
      search: `%${input.query}%`,
      limit: input.limit,
    };

    if (input.kind) {
      conditions.push("kind = @kind");
      params.kind = input.kind;
    }
    if (input.yearFrom != null) {
      conditions.push("year >= @yearFrom");
      params.yearFrom = input.yearFrom;
    }
    if (input.yearTo != null) {
      conditions.push("year <= @yearTo");
      params.yearTo = input.yearTo;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM literature_sources ${where} ORDER BY updated_at DESC LIMIT @limit`)
      .all(params) as SourceRow[];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(rows.map(formatSource), null, 2),
        },
      ],
    };
  }
);

// 3. literature:search_evidence
server.registerTool(
  "literature:search_evidence",
  {
    title: "Search Evidence Spans",
    description: "Search evidence spans (text segments) from literature sources.",
    inputSchema: {
      query: z.string().min(1).describe("Search term for evidence text"),
      sourceId: z.string().optional().describe("Filter by source ID"),
      page: z.number().int().optional().describe("Filter by page number"),
      section: z.string().optional().describe("Filter by section name"),
    },
  },
  async (input) => {
    const conditions: string[] = ["text LIKE @query"];
    const params: Record<string, unknown> = {
      query: `%${input.query}%`,
    };

    if (input.sourceId) {
      conditions.push("source_id = @sourceId");
      params.sourceId = input.sourceId;
    }
    if (input.page != null) {
      conditions.push("page = @page");
      params.page = input.page;
    }
    if (input.section) {
      conditions.push("section = @section");
      params.section = input.section;
    }

    const rows = db
      .prepare(
        `SELECT * FROM literature_evidence_spans WHERE ${conditions.join(" AND ")} ORDER BY page ASC`
      )
      .all(params) as EvidenceRow[];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(rows.map(formatEvidence), null, 2),
        },
      ],
    };
  }
);

// 4. literature:get_citation
server.registerTool(
  "literature:get_citation",
  {
    title: "Get Citation",
    description: "Get formatted citation for a literature source (bibtex, apa, or gbt7714).",
    inputSchema: {
      sourceId: z.string().min(1).describe("ID of the source to cite"),
      style: z.enum(["bibtex", "apa", "gbt7714"]).default("bibtex").describe("Citation style"),
    },
  },
  async (input) => {
    const row = db
      .prepare("SELECT * FROM literature_sources WHERE id = ?")
      .get(input.sourceId) as SourceRow | undefined;

    if (!row) {
      return {
        content: [{ type: "text" as const, text: `No source found with ID: ${input.sourceId}` }],
        isError: true,
      };
    }

    let citation: string;
    switch (input.style) {
      case "apa":
        citation = formatApa(row);
        break;
      case "gbt7714":
        citation = formatGbt7714(row);
        break;
      case "bibtex":
      default:
        citation = row.bibtex || formatBibtex(row);
        break;
    }

    return {
      content: [{ type: "text" as const, text: citation }],
    };
  }
);

// 5. literature:extract_paper_card
server.registerTool(
  "literature:extract_paper_card",
  {
    title: "Extract Paper Card",
    description: "Extract or update a structured paper card (problem, method, findings, limitations, ideas) from a literature source.",
    inputSchema: {
      sourceId: z.string().min(1).describe("ID of the source"),
      researchProblem: z.string().default("").describe("Research problem statement"),
      methodSummary: z.string().default("").describe("Method summary"),
      datasets: z.array(z.string()).default([]).describe("Datasets used"),
      metrics: z.array(z.string()).default([]).describe("Evaluation metrics"),
      keyFindings: z.array(z.string()).default([]).describe("Key findings"),
      limitations: z.array(z.string()).default([]).describe("Limitations noted"),
      reusableIdeas: z.array(z.string()).default([]).describe("Reusable ideas"),
      evidenceSpanIds: z.array(z.string()).default([]).describe("Related evidence span IDs"),
    },
  },
  async (input) => {
    const sourceRow = db
      .prepare("SELECT * FROM literature_sources WHERE id = ?")
      .get(input.sourceId) as SourceRow | undefined;

    if (!sourceRow) {
      return {
        content: [{ type: "text" as const, text: `No source found with ID: ${input.sourceId}` }],
        isError: true,
      };
    }

    const card = {
      researchProblem: input.researchProblem,
      methodSummary: input.methodSummary,
      datasets: input.datasets,
      metrics: input.metrics,
      keyFindings: input.keyFindings,
      limitations: input.limitations,
      reusableIdeas: input.reusableIdeas,
    };

    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO literature_paper_cards (id, source_id, card_json, evidence_span_ids_json, created_at, updated_at)
      VALUES (@id, @source_id, @card_json, @evidence_span_ids_json, @created_at, @updated_at)
      ON CONFLICT(source_id) DO UPDATE SET
        card_json = @card_json,
        evidence_span_ids_json = @evidence_span_ids_json,
        updated_at = @updated_at
    `).run({
      id,
      source_id: input.sourceId,
      card_json: JSON.stringify(card),
      evidence_span_ids_json: JSON.stringify(input.evidenceSpanIds),
      created_at: now,
      updated_at: now,
    });

    const result = db
      .prepare("SELECT * FROM literature_paper_cards WHERE source_id = ?")
      .get(input.sourceId) as PaperCardRow;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(formatPaperCard(result), null, 2),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Literature MCP server failed to start:", err);
  process.exit(1);
});