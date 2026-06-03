export type LiteratureCitationStyle = "bibtex" | "apa" | "gbt7714";

export interface CitationSource {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  bibtex?: string;
  citationKey?: string;
}

function generateBibtex(source: CitationSource): string {
  const lastName = (source.authors[0]?.split(" ") ?? []).pop()?.toLowerCase() ?? "";
  const key = source.citationKey || lastName + (source.year || "");
  const authors = source.authors.join(" and ") || "Unknown";
  return [
    `@article{${key},`,
    `  author = {${authors}},`,
    `  title = {${source.title}},`,
    `  year = {${source.year || "n.d."}},`,
    `  journal = {${source.venue || ""}},`,
    `  doi = {${source.doi || ""}}`,
    "}",
  ].join("\n");
}

function generateApa(source: CitationSource): string {
  const authorStr = source.authors
    .map((author) => {
      const parts = author.split(" ");
      const lastName = parts.pop() || author;
      return `${lastName}, ${parts.map((part) => part[0] + ".").join("")}`;
    })
    .join(", ");

  return [
    `${authorStr || "Unknown"} (${source.year || "n.d."}). ${source.title}.`,
    `${source.venue || ""}.`,
    source.doi ? `https://doi.org/${source.doi}` : "",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateGbt7714(source: CitationSource): string {
  const authors = source.authors.join(", ") || "Unknown";
  return [
    `${authors}. ${source.title}[J].`,
    `${source.venue || ""}, ${source.year || "n.d."}`,
    source.doi ? `. DOI:${source.doi}` : "",
    ".",
  ].join("");
}

export function formatLiteratureCitation(
  source: CitationSource,
  style: LiteratureCitationStyle,
): string {
  switch (style) {
    case "apa":
      return generateApa(source);
    case "gbt7714":
      return generateGbt7714(source);
    case "bibtex":
    default:
      return source.bibtex || generateBibtex(source);
  }
}
