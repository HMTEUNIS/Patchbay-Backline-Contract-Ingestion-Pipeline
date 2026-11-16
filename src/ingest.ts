/**
 * CLI orchestration: parse a folder of PDFs, extract terms, validate, confirm
 * amendments, then insert label.* and rag.contract_chunks.
 */

import { existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { stdin, stdout } from "node:process";

import { artistKey } from "./artists.js";
import { loadConfig } from "./config.js";
import {
  createPool,
  docPathExists,
  findArtistsByStageName,
  findBaseContracts,
  IdAllocator,
  readMaxIds,
  withTransaction,
  type ArtistRow,
} from "./db.js";
import { assertOllamaReady, extractContract, type ModelExtraction } from "./extract.js";
import { insertContract, writeSidecar, type InsertPlan } from "./insert.js";
import { chunkDocument, parsePdf, unreadableReason, type ClauseChunk, type ParsedDocument } from "./parse.js";
import {
  applyReplacedSections,
  confirmArtistFields,
  confirmKind,
  confirmReplacedSections,
  confirmSupersession,
  ReviewError,
  type Prompter,
} from "./review.js";
import {
  assertDollarsInSource,
  parseTermsDoc,
  repairCommaDollars,
  type SectionKey,
  type TermsDoc,
} from "./validate.js";

type Io = {
  log: (line: string) => void;
  prompter: Prompter;
};

type FileStatus = "ok" | "skip" | "fail" | "dry-run";

type Outcome = {
  file: string;
  status: FileStatus;
  detail: string;
};

type ExtractedFile = {
  file: string;
  docPath: string;
  parsed: ParsedDocument;
  chunks: ClauseChunk[];
  extraction: ModelExtraction;
};

type ResolvedArtist = {
  id: number;
  isNew: boolean;
  inserted: boolean;
  stageName: string;
  legalName: string;
  country: string | null;
  joinedAt: string | null;
};

type ReadyFile = {
  extracted: ExtractedFile;
  artist: ResolvedArtist;
  contractId: number;
  terms: TermsDoc;
  chunks: ClauseChunk[];
};

const USAGE = `Usage: npm run ingest -- <folder> [--dry-run] [--allow-missing-sidecar]

Reads PDF contracts from <folder> (not subfolders). A real insert requires
BACKLINE_DATA_DIR so make embed can see the new sidecar. --dry-run parses,
extracts, and validates, then writes nothing. Amendments with no eligible base
contract are refused. One bad file does not stop the rest of the folder.`;

export function parseCli(argv: readonly string[]): {
  help: boolean;
  dryRun: boolean;
  allowMissingSidecar: boolean;
  folder: string | null;
} {
  let dryRun = false;
  let allowMissingSidecar = false;
  let help = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--allow-missing-sidecar") allowMissingSidecar = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") help = true;
    else if (arg === "ingest" || arg === "--") continue;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Pass one folder of PDF contracts.");
  return { help, dryRun, allowMissingSidecar, folder: positional[0] ?? null };
}

export function listPdfs(folder: string): string[] {
  const entries = readdirSync(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => resolve(folder, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function toDocPath(filePath: string): string {
  const absolute = resolve(filePath);
  const rel = relative(process.cwd(), absolute);
  const chosen = rel.startsWith("..") ? absolute : rel;
  return chosen.split(sep).join("/");
}

export async function runIngest(argv: readonly string[]): Promise<number> {
  const args = parseCli(argv);
  if (args.help || !args.folder) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }

  const config = loadConfig(process.env);
  const folder = resolve(args.folder);
  let pdfs: string[];
  try {
    pdfs = listPdfs(folder);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (pdfs.length === 0) {
    console.error(`No PDF files in ${folder}.`);
    return 1;
  }

  requireSidecarDir(config.backlineDataDir, args.dryRun, args.allowMissingSidecar);

  const prompt = makePrompter();
  const io: Io = { log: (line) => console.log(line), prompter: prompt.ask };
  const pool = createPool(config.databaseUrl);
  const outcomes: Outcome[] = [];

  try {
    await checkReady(pool, config.ollamaHost, config.ollamaModel, io);
    const max = await readMaxIds(pool);
    const ids = new IdAllocator(max.artists, max.contracts);
    io.log(`Connected. Next artist id ${max.artists + 1}, next contract id ${max.contracts + 1}.`);
    if (!config.backlineDataDir) {
      io.log(
        "BACKLINE_DATA_DIR is unset, so this run will not write sidecars. make embed stops if any contract is missing contracts/txt/<stem>.txt. It does not change chunks when it stops.",
      );
    }

    const extracted: ExtractedFile[] = [];
    for (const file of pdfs) {
      const outcome = await extractOne(pool, config, file, io);
      if ("failure" in outcome) outcomes.push(outcome.failure);
      else extracted.push(outcome.file);
    }

    const artists = await resolveArtists(pool, ids, extracted, outcomes);
    await fillNewArtists(artists, extracted, args.dryRun, io, outcomes);
    const ready = await prepareFiles(ids, extracted, artists, args.dryRun, io, outcomes);

    const bases = ready.filter((file) => file.terms.meta.kind === "base");
    const amendments = ready.filter((file) => file.terms.meta.kind === "amendment");

    for (const file of bases) {
      outcomes.push(await commitFile(pool, file, null, config.backlineDataDir, args.dryRun, io));
    }
    for (const file of amendments) {
      outcomes.push(await commitAmendment(pool, file, config.backlineDataDir, args.dryRun, io));
    }
  } finally {
    prompt.close();
    await pool.end();
  }

  const counts = { ok: 0, skip: 0, fail: 0, "dry-run": 0 };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  io.log(
    `Done. inserted ${counts.ok}, dry-run ${counts["dry-run"]}, skipped ${counts.skip}, failed ${counts.fail}.`,
  );
  if (counts.ok > 0) {
    io.log("Embeddings are still NULL. From the Backline repo, run: make embed");
  }
  return counts.fail > 0 ? 1 : 0;
}

async function checkReady(pool: ReturnType<typeof createPool>, host: string, model: string, io: Io): Promise<void> {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not connect using DATABASE_URL. ${detail}`);
  }
  io.log(`Ollama model ${model} at ${host}.`);
  await assertOllamaReady(host, model);
}

async function extractOne(
  pool: ReturnType<typeof createPool>,
  config: ReturnType<typeof loadConfig>,
  file: string,
  io: Io,
): Promise<{ file: ExtractedFile } | { failure: Outcome }> {
  const name = basename(file);
  try {
    const docPath = toDocPath(file);
    if (await docPathExists(pool, docPath)) {
      io.log(`[skip] ${name}  already ingested as ${docPath}`);
      return { failure: { file, status: "skip", detail: "already ingested" } };
    }
    const parsed = await parsePdf(file);
    const reason = unreadableReason(parsed.text);
    if (reason) {
      io.log(`[fail] ${name}  ${reason}`);
      return { failure: { file, status: "fail", detail: reason } };
    }
    io.log(
      `[extract] ${name}  ${parsed.pages.length} page(s). Waiting on ${config.ollamaModel}; CPU often needs several minutes per file.`,
    );
    const extraction = await extractContract({
      host: config.ollamaHost,
      model: config.ollamaModel,
      fileName: name,
      pages: parsed.pages,
    });
    const chunks = chunkDocument(parsed.text, { linePages: parsed.linePages });
    return { file: { file, docPath, parsed, chunks, extraction } };
  } catch (err) {
    const detail = errorMessage(err);
    io.log(`[fail] ${name}  ${detail}`);
    return { failure: { file, status: "fail", detail } };
  }
}

async function resolveArtists(
  pool: ReturnType<typeof createPool>,
  ids: IdAllocator,
  files: ExtractedFile[],
  outcomes: Outcome[],
): Promise<Map<string, ResolvedArtist>> {
  const artists = new Map<string, ResolvedArtist>();
  const failedKeys = new Set<string>();
  for (const file of files) {
    const key = artistKey(file.extraction.artist.stageName);
    if (artists.has(key) || failedKeys.has(key)) continue;
    const matches = await findArtistsByStageName(pool, file.extraction.artist.stageName);
    if (matches.length > 1) {
      failedKeys.add(key);
      const idsLabel = matches.map((row) => row.id).join(", ");
      const detail = `Several artists match ${file.extraction.artist.stageName} (ids ${idsLabel}). Not inserted.`;
      for (const pending of files.filter((item) => artistKey(item.extraction.artist.stageName) === key)) {
        console.log(`[fail] ${basename(pending.file)}  ${detail}`);
        outcomes.push({ file: pending.file, status: "fail", detail });
      }
      continue;
    }
    const existing = matches[0];
    if (existing) {
      artists.set(key, fromExisting(existing));
    } else {
      artists.set(key, {
        id: ids.nextArtist(),
        isNew: true,
        inserted: false,
        stageName: file.extraction.artist.stageName,
        legalName: file.extraction.artist.legalName,
        country: file.extraction.artist.country,
        joinedAt: file.extraction.artist.joinedAt,
      });
    }
  }
  return artists;
}

async function fillNewArtists(
  artists: Map<string, ResolvedArtist>,
  files: ExtractedFile[],
  dryRun: boolean,
  io: Io,
  outcomes: Outcome[],
): Promise<void> {
  for (const [key, artist] of artists) {
    if (!artist.isNew) continue;
    if (isIsoDate(artist.joinedAt) && isCountry(artist.country)) continue;
    const owned = files.filter((file) => artistKey(file.extraction.artist.stageName) === key);
    if (dryRun) {
      io.log(
        `[dry-run] new artist ${artist.stageName} is missing country or joined_at; an interactive run will ask before insert.`,
      );
      continue;
    }
    const suggested = earliestDate(owned.map((file) => file.extraction.meta.effectiveFrom));
    try {
      const confirmed = await confirmArtistFields(
        io.prompter,
        { stageName: artist.stageName, country: artist.country, joinedAt: artist.joinedAt },
        suggested,
      );
      if (confirmed === "skip") {
        artists.delete(key);
        for (const file of owned) {
          io.log(`[skip] ${basename(file.file)}  artist ${artist.stageName} skipped`);
          outcomes.push({ file: file.file, status: "skip", detail: "artist skipped" });
        }
        continue;
      }
      artist.country = confirmed.country;
      artist.joinedAt = confirmed.joinedAt;
    } catch (err) {
      artists.delete(key);
      const detail = errorMessage(err);
      for (const file of owned) {
        io.log(`[fail] ${basename(file.file)}  ${detail}`);
        outcomes.push({ file: file.file, status: "fail", detail });
      }
    }
  }
}

async function prepareFiles(
  ids: IdAllocator,
  files: ExtractedFile[],
  artists: Map<string, ResolvedArtist>,
  dryRun: boolean,
  io: Io,
  outcomes: Outcome[],
): Promise<ReadyFile[]> {
  const ready: ReadyFile[] = [];
  for (const file of files) {
    const name = basename(file.file);
    const artist = artists.get(artistKey(file.extraction.artist.stageName));
    if (!artist) continue;
    try {
      const kind = await resolveKind(file.extraction, dryRun, io);
      if (kind === "skip") {
        io.log(`[skip] ${name}  kind left unconfirmed`);
        outcomes.push({ file: file.file, status: "skip", detail: "kind skipped" });
        continue;
      }
      const sections = { ...file.extraction.sections };
      let replaced = [...file.extraction.meta.replacedSections];
      if (kind === "base") {
        replaced = [];
      } else if (file.extraction.replacedSectionsUncertain || replaced.length === 0) {
        if (dryRun) {
          io.log(`[dry-run] ${name}  replaced sections are unconfirmed (${replaced.join(", ") || "none"}).`);
          outcomes.push({ file: file.file, status: "fail", detail: "replaced sections need confirmation" });
          continue;
        }
        const confirmed = await confirmReplacedSections(io.prompter, replaced, file.extraction.reviewNote);
        if (confirmed === "skip") {
          io.log(`[skip] ${name}  replaced sections left unconfirmed`);
          outcomes.push({ file: file.file, status: "skip", detail: "sections skipped" });
          continue;
        }
        replaced = confirmed;
        const trimmed = applyReplacedSections(sections, confirmed);
        for (const key of Object.keys(sections)) delete sections[key];
        Object.assign(sections, trimmed);
      }

      const contractId = ids.nextContract();
      const terms = parseTermsDoc({
        meta: {
          contract_id: contractId,
          artist_id: artist.id,
          kind,
          effective_from: file.extraction.meta.effectiveFrom,
          effective_to: file.extraction.meta.effectiveTo,
          replaced_sections: replaced,
        },
        sections,
      });
      for (const note of repairCommaDollars(file.extracted.parsed.text, terms)) {
        io.log(`[repair] ${name}  ${note}`);
      }
      assertDollarsInSource(file.extracted.parsed.text, terms);
      if (terms.meta.kind === "base" && terms.sections.royalties?.rate_card.length === 0) {
        io.log(`[warn] ${name}  royalties.rate_card is empty`);
      }
      if (!artist.isNew && artist.legalName !== file.extraction.artist.legalName) {
        io.log(
          `[note] ${name}  matched existing artist ${artist.id} (${artist.stageName}); extracted legal name differs`,
        );
      }
      ready.push({ extracted: file, artist, contractId, terms, chunks: file.chunks });
    } catch (err) {
      const detail = errorMessage(err);
      io.log(`[fail] ${name}  ${detail}`);
      if (file.extraction) {
        io.log(JSON.stringify(previewTerms(file, artist.id), null, 2));
      }
      outcomes.push({ file: file.file, status: "fail", detail });
    }
  }
  return ready;
}

async function resolveKind(
  extraction: ModelExtraction,
  dryRun: boolean,
  io: Io,
): Promise<"base" | "amendment" | "skip"> {
  if (!extraction.kindUncertain) return extraction.meta.kind;
  if (dryRun) {
    io.log(`[dry-run] kind is ambiguous; keeping ${extraction.meta.kind}. ${extraction.reviewNote}`.trim());
    return extraction.meta.kind;
  }
  return confirmKind(io.prompter, extraction.reviewNote);
}

async function commitFile(
  pool: ReturnType<typeof createPool>,
  file: ReadyFile,
  supersedesContractId: number | null,
  dataDir: string | null,
  dryRun: boolean,
  io: Io,
): Promise<Outcome> {
  const name = basename(file.extracted.file);
  let plan: InsertPlan;
  try {
    plan = toPlan(file, supersedesContractId);
  } catch (err) {
    const detail = errorMessage(err);
    if (dryRun) {
      io.log(`[dry-run] ${name}  ${detail}`);
      io.log(JSON.stringify(file.terms, null, 2));
      return { file: file.extracted.file, status: "dry-run", detail };
    }
    io.log(`[fail] ${name}  ${detail}`);
    return { file: file.extracted.file, status: "fail", detail };
  }
  const cite = citeChunks(file.chunks);
  if (dryRun) {
    io.log(
      `[dry-run] ${name}  ${plan.kind} contract ${plan.contractId} artist ${plan.artistId} chunks ${plan.chunks.length}`,
    );
    io.log(`  ${cite}`);
    io.log(JSON.stringify(plan.terms, null, 2));
    return { file: file.extracted.file, status: "dry-run", detail: "validated, not inserted" };
  }
  try {
    await withTransaction(pool, (client) => insertContract(client, plan));
    file.artist.inserted = true;
    io.log(
      `[ok] ${name}  ${plan.kind} contract ${plan.contractId} artist ${plan.artistId}${
        supersedesContractId == null ? "" : ` supersedes ${supersedesContractId}`
      } ${rateSummary(plan.terms)} chunks ${plan.chunks.length}`,
    );
    io.log(`  ${cite}`);
    if (dataDir) {
      const sidecar = await writeSidecar(dataDir, name, file.extracted.parsed.text);
      if (sidecar.status === "wrote") io.log(`  sidecar ${sidecar.path}`);
      else if (sidecar.status === "conflict") {
        io.log(`  sidecar already exists and differs, left untouched: ${sidecar.path}`);
      }
    }
    return { file: file.extracted.file, status: "ok", detail: "inserted" };
  } catch (err) {
    const detail = errorMessage(err);
    io.log(`[fail] ${name}  ${detail}`);
    return { file: file.extracted.file, status: "fail", detail };
  }
}

async function commitAmendment(
  pool: ReturnType<typeof createPool>,
  file: ReadyFile,
  dataDir: string | null,
  dryRun: boolean,
  io: Io,
): Promise<Outcome> {
  const name = basename(file.extracted.file);
  try {
    const candidates = await findBaseContracts(pool, file.artist.id, file.terms.meta.effective_from);
    if (dryRun) {
      const listed = candidates.map((candidate) => candidate.id).join(", ") || "none";
      io.log(
        `[dry-run] ${name}  would ask which base contract this amendment supersedes. Candidates: ${listed}.`,
      );
      return commitFile(pool, file, null, dataDir, true, io);
    }
    io.log(JSON.stringify(file.terms, null, 2));
    const decision = await confirmSupersession(io.prompter, {
      replacedSections: file.terms.meta.replaced_sections,
      candidates,
    });
    if (decision.action === "skip") {
      io.log(`[skip] ${name}  supersession left unconfirmed`);
      return { file: file.extracted.file, status: "skip", detail: "supersession skipped" };
    }
    return commitFile(pool, file, decision.supersedesContractId, dataDir, false, io);
  } catch (err) {
    const detail = errorMessage(err);
    io.log(`[fail] ${name}  ${detail}`);
    return { file: file.extracted.file, status: "fail", detail };
  }
}

function toPlan(file: ReadyFile, supersedesContractId: number | null): InsertPlan {
  const artist = file.artist;
  const needsInsert = artist.isNew && !artist.inserted;
  if (needsInsert && (!isCountry(artist.country) || !isIsoDate(artist.joinedAt))) {
    throw new Error(`New artist ${artist.stageName} still needs a country code and joined_at.`);
  }
  return {
    newArtist: needsInsert
      ? {
          id: artist.id,
          stageName: artist.stageName,
          legalName: artist.legalName,
          joinedAt: artist.joinedAt ?? "",
          country: artist.country ?? "",
        }
      : null,
    contractId: file.contractId,
    artistId: artist.id,
    docPath: file.extracted.docPath,
    effectiveFrom: file.terms.meta.effective_from,
    effectiveTo: file.terms.meta.effective_to,
    kind: file.terms.meta.kind,
    terms: file.terms,
    supersedesContractId,
    chunks: file.chunks,
  };
}

function fromExisting(row: ArtistRow): ResolvedArtist {
  return {
    id: row.id,
    isNew: false,
    inserted: true,
    stageName: row.stageName,
    legalName: row.legalName,
    country: row.country,
    joinedAt: row.joinedAt,
  };
}

function previewTerms(file: ExtractedFile, artistId: number): unknown {
  return {
    meta: {
      contract_id: null,
      artist_id: artistId,
      kind: file.extraction.meta.kind,
      effective_from: file.extraction.meta.effectiveFrom,
      effective_to: file.extraction.meta.effectiveTo,
      replaced_sections: file.extraction.meta.replacedSections,
    },
    sections: file.extraction.sections,
    review_note: file.extraction.reviewNote,
  };
}

function rateSummary(terms: TermsDoc): string {
  const card = terms.sections.royalties?.rate_card ?? [];
  if (card.length === 0) return "";
  return card.map((entry) => `${entry.revenue_type}/${entry.territory}=${entry.rate}`).join(" ");
}

function citeChunks(chunks: ClauseChunk[]): string {
  return chunks
    .filter((chunk) => chunk.part === 0)
    .map((chunk) => {
      if (chunk.pageStart == null) return chunk.clauseNo;
      if (chunk.pageEnd == null || chunk.pageEnd === chunk.pageStart) return `${chunk.clauseNo} p.${chunk.pageStart}`;
      return `${chunk.clauseNo} p.${chunk.pageStart}-${chunk.pageEnd}`;
    })
    .join(", ");
}

function earliestDate(values: readonly string[]): string | null {
  const dates = values.filter(isIsoDate).sort();
  return dates[0] ?? null;
}

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isCountry(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof ReviewError || err instanceof Error) return err.message;
  return String(err);
}

function requireSidecarDir(dataDir: string | null, dryRun: boolean, allowMissing: boolean): void {
  if (dryRun || allowMissing) return;
  if (!dataDir) {
    throw new Error(
      "Set BACKLINE_DATA_DIR to Backline's data directory before inserting. make embed reads contracts/txt/<stem>.txt for every contract and stops if one file is missing. --dry-run writes nothing. --allow-missing-sidecar inserts anyway and leaves the sidecar for you to copy.",
    );
  }
  const txtDir = join(dataDir, "contracts", "txt");
  if (!existsSync(txtDir)) {
    throw new Error(
      `BACKLINE_DATA_DIR (${dataDir}) has no contracts/txt directory. Point it at the data folder that already holds the seeded sidecars.`,
    );
  }
}

function makePrompter(): { ask: Prompter; close: () => void } {
  if (!stdin.isTTY) {
    return {
      ask: async () => {
        throw new ReviewError("This file needs a person to confirm it. Re-run ingest in an interactive terminal.");
      },
      close: () => undefined,
    };
  }
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  };
}
