/**
 * Copy contract PDFs into documents/{artist}/{base|amendments}/ and, when
 * Postgres is up, store that relative path on the contract and its clauses.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { createPool, ensureSourceColumns } from "../src/db.js";
import { copySourcePdf, documentsRoot, sourceRelativePath } from "../src/sources.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
dotenv.config({ path: resolve(root, ".env") });

const folders = [
  resolve(root, "sample-contracts"),
  resolve(root, "../backline/data/contracts"),
];

const dest = documentsRoot();
let copied = 0;
const byName = new Map<string, string>();

for (const folder of folders) {
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.toLowerCase().endsWith(".pdf"));
  } catch {
    console.log(`skip missing folder ${folder}`);
    continue;
  }
  for (const name of names) {
    const relativePath = sourceRelativePath(name);
    await copySourcePdf(dest, resolve(folder, name), relativePath);
    byName.set(name, relativePath);
    copied += 1;
  }
}

console.log(`Copied ${copied} PDF(s) under ${dest}`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log("DATABASE_URL is unset, so no rows were updated.");
  process.exit(0);
}

const pool = createPool(databaseUrl);
try {
  await pool.query("SELECT 1");
  await ensureSourceColumns(pool);
  let contracts = 0;
  for (const [name, relativePath] of byName) {
    const updated = await pool.query(
      `UPDATE label.contracts
       SET source_path = $1
       WHERE regexp_replace(doc_path, '^.*[/\\\\]', '') = $2
         AND source_path IS DISTINCT FROM $1`,
      [relativePath, name],
    );
    contracts += updated.rowCount ?? 0;
  }
  const chunks = await pool.query(
    `UPDATE rag.contract_chunks AS chunk
     SET source_path = contract.source_path
     FROM label.contracts AS contract
     WHERE chunk.contract_id = contract.id
       AND contract.source_path IS NOT NULL
       AND chunk.source_path IS DISTINCT FROM contract.source_path`,
  );
  console.log(`Updated ${contracts} contract row(s) and ${chunks.rowCount ?? 0} clause row(s).`);
  console.log("Stored paths have no host prefix. The demo app adds the folder it serves.");
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`PDFs were copied, but the database was not updated. ${detail}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
