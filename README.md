# Patchbay

Patchbay turns a folder of text-based contract PDFs into rows in an existing Backline database. It is a separate process. It leaves Backline's source alone.

It writes `label.artists`, `label.contracts`, `label.contract_terms`, `label.amendments`, and `rag.contract_chunks`. Extraction uses a local Ollama model (`llama3.2:3b`) with two few-shot examples and a JSON schema. Every document is checked against Backline's terms rules before insert. An amendment is inserted only after a person confirms which base contract it supersedes.

Embeddings stay `NULL`. Backline's `make embed` fills them.

## Setup

Backline's Postgres has to be running (`make up` in the Backline repo). Ollama has to be running with the model pulled:

```bash
ollama pull llama3.2:3b
```

```bash
cd patchbay
cp .env.example .env
npm install
```

`.env` is gitignored. Only `.env.example` is in the repo. Values are read from the environment:

```text
DATABASE_URL=postgresql://backline:backline@localhost:5432/backline
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
BACKLINE_DATA_DIR=../backline/data
```

`BACKLINE_DATA_DIR` is required before the first real insert. Set it to Backline's data directory, the folder that already contains `contracts/txt/`. After each insert Patchbay writes `contracts/txt/<pdf stem>.txt` there and leaves an existing different file untouched.

`make embed` opens that path for every contract in the database. A missing sidecar stops the job before it changes any chunks, including the seeded ones. A sidecar that is present, but does not contain a stored chunk, causes that chunk to be deleted when the job finishes. Run `make embed` once on the unmodified seed before the first ingest so you know the baseline works. Then ingest, confirm the new file is beside the seeded sidecars, and run `make embed` again.

`--dry-run` does not need `BACKLINE_DATA_DIR`. A real insert without it exits before any row is written. `--allow-missing-sidecar` inserts anyway and leaves the sidecar for you to copy.

`label.artists.id` and `label.contracts.id` are explicit bigints with no sequences. At startup Patchbay runs `SELECT COALESCE(MAX(id), 0)` on both tables and increments from those values in memory. Inserts pass the id explicitly.

## Ingest

```bash
npm run ingest -- ./contracts --dry-run
npm run ingest -- ./contracts
```

The folder is not walked recursively. Only `*.pdf` files in that directory are read. Files are handled one by one. A rejected or skipped file is logged, and the run continues. The process exits 1 if any file failed, after the summary line.

`--dry-run` still connects to Postgres and still calls Ollama. It parses, extracts, and validates, prints the terms JSON and clause citations, and writes nothing. It does not ask questions. An ambiguous kind keeps the model's value and says so. An amendment whose replaced sections are uncertain is failed, because that choice needs a person. An amendment with known sections lists the eligible base-contract ids, or `none`.

For each file on a real run:

1. Extract text per page with `unpdf`, and keep page numbers for the citation log. Each PDF is opened on its own so one file cannot leak text into the next.
2. Split the text into clause chunks. A line that starts with `§1.` or `§A1.` starts a clause. The clause number is the token before the period (`§3`, `§A1`). The heading stored on the chunk is that full line (`§3. ROYALTIES`). Text before the first numbered heading is one chunk with `clause_no` `title` and `heading` equal to the contract's first line, for example `RECORDING AND ROYALTY AGREEMENT — FBR-C-00501`. A body mention such as `§3 (Royalties)` stays inside the amendment clause. `content_hash` is the sha256 of the clause body. Page numbers are printed in the log and are not columns in `rag.contract_chunks`.
3. Ask Ollama for terms. Rates in the prompt examples are strings (`"0.30"`). Percentages in the PDF (`20%`) are supposed to come back as decimal strings (`"0.20"`).
4. Validate. A failure prints the error and the extracted JSON. That file is not inserted.
5. For `kind: "amendment"`, ask: "This amendment replaces [sections]. Which base contract does it supersede?" The choices are `label.contracts` rows for the same artist with `kind = 'base'` and `effective_from` on or before the amendment. Bases from the same run are inserted first, so they appear in that list. If the list is empty, the file is failed and nothing is inserted. `supersedes_contract_id` is `NOT NULL`, so there is no row to write without a base.
6. Insert the artist when the stage name is new, then the contract, terms, amendment row, and chunks. Chunk `embedding` and `embedding_model` are `NULL`.

A new artist needs `country` and `joined_at`. Contracts in this corpus usually state neither, so Patchbay asks. An existing artist is reused when the stage names match after this normalization: Unicode NFKC, curly quotes folded to straight quotes, trimmed, internal whitespace collapsed, case-insensitive. One match reuses that row. Two matches fail the file, so a case-only pair such as `Horizon` and `horizon` is not silently merged. A different spelling inserts a new artist.

Re-running the same folder from the same working directory skips a file whose `doc_path` is already stored.

When the run inserts anything, finish in the Backline repo:

```bash
make embed
```

## Validation

The checker follows `backline/royaltycalc/terms.py` and `tests/royaltycalc/test_terms.py`.

| Check | What fails |
| --- | --- |
| `rate` | Must be a string in `[0, 1]`. `0.30` raises `TypeError`. `"1.01"` and `"-0.10"` fail. |
| `revenue_type` | `streaming`, `download`, `sync`, `physical`. Anything else, including `merch`, rejects the whole document. |
| `kind` | `base` or `amendment`. |
| Base sections | All three sections, and `replaced_sections` is `[]`. |
| Amendment sections | The section keys are exactly `replaced_sections`. An empty list, an unknown key, or an extra section fails. |
| Rate card | No duplicate `(revenue_type, territory)` pair. |

An unfamiliar `revenue_type` rejects the file. The other rates are not saved without it. `tests/validate.test.ts` covers `merch`, and `tests/validate.test.ts` plus `tests/insert.test.ts` cover a float rate that throws before any write.

`revenue_type` is the set observed in Backline's seed. If a future parser accepts a wider set, Patchbay will still refuse the document and print the type.

## Tests

```bash
npm test
npm run typecheck
```

`tests/parse.test.ts` reads one base PDF and one amendment PDF when the sibling `backline/data/contracts` tree is present. The Ollama call itself is not exercised. The float-rate and unknown-type cases are fixtures, so they run without a model.

## Verification

1. `psql "$DATABASE_URL" -c "SELECT 1"`
2. In the Backline repo, `make embed` succeeds on the seed before any Patchbay insert.
3. Startup log shows the next artist and contract ids, taken from `MAX(id)`.
4. A base PDF produces terms JSON and a `label.contract_terms` row.
5. An amendment PDF reports `replaced_sections`, waits for a base-contract choice, and writes `label.amendments`. A folder that contains only an amendment, with no eligible base, fails that file and continues.
6. A float rate or an unknown section is rejected with no insert. `npm test` covers this without the model.
7. `rag.contract_chunks` rows for the new contract have `embedding IS NULL`.
8. The new sidecar is `{BACKLINE_DATA_DIR}/contracts/txt/<pdf stem>.txt`. After `make embed`, `embedding` is populated and the seeded chunks are still present.
9. Ask Backline's Counsel agent about the contract; it should retrieve those clauses.

## Limitations

Few-shot prompting is not fine-tuning. `llama3.2:3b` can still misread unusual language. Validation catches structural mistakes, not a wrong rate that is still a plausible string. Amendment review is mandatory.

Patchbay requires `term_territory` on base contracts. Backline's parser treats that section as optional. A base contract that omits territory terms is rejected here, and the stored JSON still passes `parse_terms_doc` when the section is present with `excluded_territories`.

Scanned PDFs are out of scope. Empty or garbage text is flagged and skipped. There is no OCR.

Section detection is a heuristic. Numbered Backline headings (`§3. ROYALTIES`) split cleanly. Other layouts fall back to the heading text as `clause_no`, and a heading that is not on its own line will not split.

`make embed` is the integration that can affect the rest of the database. A missing sidecar stops the job with the existing chunks left in place. A completed run deletes a chunk the sidecar does not contain. Set `BACKLINE_DATA_DIR` before inserting. Patchbay does not generate embeddings, ingest statements, calculate royalties, or change Backline.

## Layout

```text
src/artists.ts    stage-name matching
src/db.ts         connection, MAX(id), lookups
src/parse.ts      PDF text and clause chunks
src/extract.ts    Ollama few-shot prompt and JSON schema
src/validate.ts   terms rules
src/review.ts     amendment and new-artist prompts
src/insert.ts     label.* and rag.contract_chunks
src/ingest.ts     folder walk
scripts/ingest.ts CLI
prompts/          base and amendment few-shot examples
```
