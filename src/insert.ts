/**
 * Writes one accepted contract. parseTermsDoc runs before any statement, so a bad
 * document cannot reach label.contract_terms.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ClauseChunk } from "./parse.js";
import { parseTermsDoc, type TermsDoc } from "./validate.js";

export type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export type InsertPlan = {
  newArtist: {
    id: number;
    stageName: string;
    legalName: string;
    joinedAt: string;
    country: string;
  } | null;
  contractId: number;
  artistId: number;
  docPath: string;
  /** Relative PDF path, such as nova-hale/amendments/PB-A-0001_nova-hale.pdf. No host prefix. */
  sourcePath: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  kind: "base" | "amendment";
  terms: TermsDoc;
  supersedesContractId: number | null;
  chunks: ClauseChunk[];
};

export async function insertContract(client: Queryable, plan: InsertPlan): Promise<void> {
  const terms = parseTermsDoc(plan.terms);
  if (terms.meta.kind === "amendment" && plan.supersedesContractId == null) {
    throw new Error("amendment insert requires a confirmed supersedes_contract_id");
  }
  if (terms.meta.contract_id !== plan.contractId || terms.meta.artist_id !== plan.artistId) {
    throw new Error("terms meta ids do not match the insert plan");
  }

  if (plan.newArtist) {
    await client.query(
      `INSERT INTO label.artists (id, stage_name, legal_name, joined_at, country)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        plan.newArtist.id,
        plan.newArtist.stageName,
        plan.newArtist.legalName,
        plan.newArtist.joinedAt,
        plan.newArtist.country,
      ],
    );
  }

  await client.query(
    `INSERT INTO label.contracts (id, artist_id, doc_path, effective_from, effective_to, kind, source_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      plan.contractId,
      plan.artistId,
      plan.docPath,
      plan.effectiveFrom,
      plan.effectiveTo,
      plan.kind,
      plan.sourcePath,
    ],
  );

  await client.query(
    `INSERT INTO label.contract_terms (contract_id, terms)
     VALUES ($1, $2::jsonb)`,
    [plan.contractId, JSON.stringify(terms)],
  );

  if (terms.meta.kind === "amendment") {
    await client.query(
      `INSERT INTO label.amendments (amendment_id, supersedes_contract_id, replaced_sections)
       VALUES ($1, $2, $3::text[])`,
      [plan.contractId, plan.supersedesContractId, terms.meta.replaced_sections],
    );
  }

  for (const chunk of plan.chunks) {
    await client.query(
      `INSERT INTO rag.contract_chunks (
         contract_id, clause_no, part, heading, content, content_hash,
         artist_id, kind, effective_from, effective_to, source_path, embedding, embedding_model
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL)`,
      [
        plan.contractId,
        chunk.clauseNo,
        chunk.part,
        chunk.heading,
        chunk.content,
        chunk.contentHash,
        plan.artistId,
        plan.kind,
        plan.effectiveFrom,
        plan.effectiveTo,
        plan.sourcePath,
      ],
    );
  }
}

export function sidecarPath(dataDir: string, pdfFileName: string): string {
  const stem = pdfFileName.replace(/\.pdf$/i, "");
  return join(dataDir, "contracts", "txt", `${stem}.txt`);
}

export type SidecarWrite = { path: string; status: "wrote" | "unchanged" | "conflict" };

/** Writes the chunked text where Backline's embed job looks, and never overwrites a different file. */
export async function writeSidecar(dataDir: string, pdfFileName: string, text: string): Promise<SidecarWrite> {
  const path = sidecarPath(dataDir, pdfFileName);
  const next = text.endsWith("\n") ? text : `${text}\n`;
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (existing !== null) {
    const same = existing.replace(/\r\n/g, "\n") === next.replace(/\r\n/g, "\n");
    return { path, status: same ? "unchanged" : "conflict" };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return { path, status: "wrote" };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
