/**
 * PDF text extraction and clause chunking.
 *
 * Numbered headings follow Backline's rag chunker: a clause starts only when a line
 * begins with `§1.` / `§A1.` so a body reference like `§3 (Royalties)` stays body text.
 * Page numbers stay on the chunk for citations; they are not written to the database.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { extractText, getDocumentProxy } from "unpdf";

const NUMBERED_HEADING = /^(§[A-Z]?\d+)\.\s+\S/;
const UNNUMBERED_HEADING = /^[A-Z][A-Z0-9][A-Z0-9 &'/,-]{1,78}$/;
const DEFAULT_MAX_CHARS = 2000;

export type PageText = {
  page: number;
  text: string;
};

export type ParsedDocument = {
  pages: PageText[];
  /** Text that is chunked and, when configured, written as Backline's sidecar. */
  text: string;
  linePages: number[];
};

export type ClauseChunk = {
  clauseNo: string;
  part: number;
  heading: string;
  content: string;
  contentHash: string;
  pageStart: number | null;
  pageEnd: number | null;
};

export async function parsePdf(filePath: string): Promise<ParsedDocument> {
  const bytes = new Uint8Array(await readFile(filePath));
  // A fresh document per file. The older pdf-parse build reused PDF.js state and
  // could return another contract's text, or fail with a bad xref, on the next file.
  const pdf = await getDocumentProxy(bytes);
  try {
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(extracted.text) ? extracted.text : [extracted.text]).map((page) =>
      page.replace(/\r\n/g, "\n"),
    );
    if (pages.length === 0 || pages.every((page) => page.trim() === "")) {
      return { pages: [], text: "", linePages: [] };
    }
    const assembled = assemblePages(pages);
    return {
      pages: pages.map((text, index) => ({ page: index + 1, text })),
      text: assembled.text,
      linePages: assembled.linePages,
    };
  } finally {
    await pdf.destroy();
  }
}

export function assemblePages(pages: readonly string[]): { text: string; linePages: number[] } {
  const lines: string[] = [];
  const linePages: number[] = [];
  pages.forEach((pageText, index) => {
    const page = index + 1;
    const pageLines = splitLines(pageText);
    if (lines.length > 0) {
      lines.push("");
      linePages.push(page);
    }
    for (const line of pageLines) {
      lines.push(line);
      linePages.push(page);
    }
  });
  const text = lines.join("\n");
  return { text: text.length > 0 ? `${text}\n` : "", linePages };
}

export function unreadableReason(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 40) {
    return "extracted text is empty or too short; this PDF may be a scan (no OCR in v1)";
  }
  const letters = trimmed.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters / trimmed.length < 0.25) {
    return "extracted text does not look like a contract; this PDF may be a scan (no OCR in v1)";
  }
  return null;
}

export function chunkDocument(
  text: string,
  options?: { maxChars?: number; linePages?: readonly number[] },
): ClauseChunk[] {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const linePages = options?.linePages;
  const lines = splitLines(text);
  const numbered = lines.some((line) => NUMBERED_HEADING.test(line));

  type OpenClause = { clauseNo: string; heading: string; body: string[]; headingLine: number; bodyLines: number[] };
  const clauses: OpenClause[] = [];

  lines.forEach((line, index) => {
    const numberedMatch = NUMBERED_HEADING.exec(line);
    const unnumbered = !numbered && UNNUMBERED_HEADING.test(line);
    if (numberedMatch || unnumbered) {
      const clauseNo = numberedMatch?.[1] ?? uniqueClauseNo(line, clauses);
      clauses.push({
        clauseNo,
        heading: line,
        body: [],
        headingLine: index,
        bodyLines: [],
      });
      return;
    }
    if (clauses.length === 0) {
      if (line) {
        clauses.push({
          clauseNo: "title",
          heading: line,
          body: [],
          headingLine: index,
          bodyLines: [],
        });
      }
      return;
    }
    const current = clauses[clauses.length - 1];
    if (!current) return;
    if (line || current.body.length > 0) {
      current.body.push(line);
      current.bodyLines.push(index);
    }
  });

  const chunks: ClauseChunk[] = [];
  for (const clause of clauses) {
    while (clause.body.length > 0 && clause.body[clause.body.length - 1] === "") {
      clause.body.pop();
      clause.bodyLines.pop();
    }
    const content = clause.body.filter((line) => line !== "").join("\n");
    const pieces = splitContent(content, maxChars);
    pieces.forEach((piece, part) => {
      const pageStart = pageAt(linePages, clause.headingLine);
      const lastBody = clause.bodyLines[clause.bodyLines.length - 1];
      const pageEnd = pageAt(linePages, lastBody ?? clause.headingLine);
      chunks.push({
        clauseNo: clause.clauseNo,
        part,
        heading: clause.heading,
        content: piece,
        contentHash: sha256(piece),
        pageStart,
        pageEnd,
      });
    });
  }
  return chunks;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") || text.endsWith("\r\n")) lines.pop();
  return lines.map((line) => line.replace(/[ \t\r]+$/g, ""));
}

function splitContent(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (let paragraph of content.split("\n")) {
    while (paragraph.length > maxChars) {
      if (current.length > 0) {
        parts.push(current.join("\n"));
        current = [];
        size = 0;
      }
      parts.push(paragraph.slice(0, maxChars));
      paragraph = paragraph.slice(maxChars);
    }
    let extra = paragraph.length + (current.length > 0 ? 1 : 0);
    if (size + extra > maxChars && current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
      size = 0;
      extra = paragraph.length;
    }
    current.push(paragraph);
    size += extra;
  }
  if (current.length > 0) parts.push(current.join("\n"));
  return parts;
}

function uniqueClauseNo(heading: string, existing: { clauseNo: string }[]): string {
  const used = new Set(existing.map((clause) => clause.clauseNo));
  if (!used.has(heading)) return heading;
  let n = 2;
  while (used.has(`${heading} #${n}`)) n += 1;
  return `${heading} #${n}`;
}

function pageAt(linePages: readonly number[] | undefined, index: number): number | null {
  if (!linePages) return null;
  const page = linePages[index];
  return page === undefined ? null : page;
}
