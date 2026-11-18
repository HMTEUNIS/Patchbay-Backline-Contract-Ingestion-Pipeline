/**
 * Postgres access. label.artists.id and label.contracts.id have no sequences, so the
 * session reads MAX(id) once and hands out the next ids from memory.
 */

import pg from "pg";

import { matchArtists } from "./artists.js";

export class IdAllocator {
  private nextArtistId: number;
  private nextContractId: number;

  constructor(maxArtistId: number, maxContractId: number) {
    this.nextArtistId = maxArtistId;
    this.nextContractId = maxContractId;
  }

  nextArtist(): number {
    this.nextArtistId += 1;
    return this.nextArtistId;
  }

  nextContract(): number {
    this.nextContractId += 1;
    return this.nextContractId;
  }
}

export type ArtistRow = {
  id: number;
  stageName: string;
  legalName: string;
  joinedAt: string;
  country: string;
};

export type BaseContractRow = {
  id: number;
  docPath: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 4 });
}

export async function checkConnection(pool: pg.Pool): Promise<void> {
  await pool.query("SELECT 1");
}

export async function readMaxIds(pool: pg.Pool): Promise<{ artists: number; contracts: number }> {
  try {
    const artists = await pool.query("SELECT COALESCE(MAX(id), 0) AS max_id FROM label.artists");
    const contracts = await pool.query("SELECT COALESCE(MAX(id), 0) AS max_id FROM label.contracts");
    return {
      artists: asId(artists.rows[0]?.max_id, "label.artists"),
      contracts: asId(contracts.rows[0]?.max_id, "label.contracts"),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read MAX(id) from label.artists and label.contracts. Is DATABASE_URL the Backline database with migrations applied? ${detail}`,
    );
  }
}

export async function findArtistsByStageName(pool: pg.Pool, stageName: string): Promise<ArtistRow[]> {
  const result = await pool.query(
    `SELECT id::text AS id, stage_name, legal_name, joined_at::text AS joined_at, country
     FROM label.artists
     ORDER BY id`,
  );
  const rows = result.rows.map((row: Record<string, string>) => ({
    id: asId(row.id, "label.artists.id"),
    stageName: row.stage_name ?? "",
    legalName: row.legal_name ?? "",
    joinedAt: (row.joined_at ?? "").slice(0, 10),
    country: row.country ?? "",
  }));
  return matchArtists(rows, stageName);
}

export async function findBaseContracts(
  pool: pg.Pool,
  artistId: number,
  effectiveFrom: string,
): Promise<BaseContractRow[]> {
  const result = await pool.query(
    `SELECT id::text AS id, doc_path, effective_from::text AS effective_from,
            effective_to::text AS effective_to
     FROM label.contracts
     WHERE artist_id = $1
       AND kind = 'base'
       AND effective_from <= $2::date
     ORDER BY effective_from, id`,
    [artistId, effectiveFrom],
  );
  return result.rows.map((row: Record<string, string | null>) => ({
    id: asId(row.id, "label.contracts.id"),
    docPath: row.doc_path ?? "",
    effectiveFrom: (row.effective_from ?? "").slice(0, 10),
    effectiveTo: row.effective_to ? row.effective_to.slice(0, 10) : null,
  }));
}

export async function docPathExists(pool: pg.Pool, docPath: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM label.contracts WHERE doc_path = $1 LIMIT 1", [docPath]);
  return result.rowCount !== null && result.rowCount > 0;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the one to surface.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Adds the relative source-PDF path used by the demo. Existing rows stay null until backfill. */
export async function ensureSourceColumns(pool: pg.Pool): Promise<void> {
  await pool.query("ALTER TABLE label.contracts ADD COLUMN IF NOT EXISTS source_path TEXT");
  await pool.query("ALTER TABLE rag.contract_chunks ADD COLUMN IF NOT EXISTS source_path TEXT");
}

function asId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Unexpected id from ${label}: ${String(value)}`);
  }
  return n;
}
