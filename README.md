# Patchbay

Patchbay turns a folder of text-based contract PDFs into rows in an existing Backline database. It is a separate process: it does not fork Backline, and it does not modify Backline's source.

It writes `label.artists`, `label.contracts`, `label.contract_terms`, `label.amendments`, and `rag.contract_chunks`. Extraction uses a local Ollama model (`llama3.2:3b`) with two few-shot examples and a JSON schema. Every document is checked against Backline's terms rules before insert. An amendment is inserted only after a person confirms which base contract it supersedes.

Embeddings stay `NULL`. Backline's `make embed` fills them.

## Setup

Backline's Postgres has to be running (`make up` in the Backline repo). Ollama has to be running with the model pulled:

```bash
ollama pull llama3.2:3b
```

```bash
cd patchbay
cp .env.example .env   # the committed .env already matches Backline's local URL
npm install
```

`.env` is read from the environment, not hardcoded:

```text
DATABASE_URL=postgresql://backline:backline@localhost:5432/backline
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
```

`label.artists.id` and `label.contracts.id` are explicit bigints with no sequences. At startup Patchbay runs `SELECT COALESCE(MAX(id), 0)` on both tables and increments from those values in memory. Inserts pass the id explicitly.

Optional: set `BACKLINE_DATA_DIR` to Backline's data directory (the folder that contains `contracts/`). After a successful insert, Patchbay writes `{BACKLINE_DATA_DIR}/contracts/txt/<pdf stem>.txt`. Backline's embed job looks up sidecars by that stem for every contract in the database and aborts if one is missing. An existing sidecar is never overwritten.

## Ingest

```bash
npm run ingest -- ./contracts
npm run ingest -- ./contracts --dry-run
```

The folder is not walked recursively. Only `*.pdf` files in that directory are read.

For each file:

1. Extract text per page with `unpdf`, and keep page numbers for the citation log. Each PDF is opened on its own so one file cannot leak text into the next.
2. Split the text into clause chunks (`§1`, `§A1`, or the heading text when a contract has no numbered headings). The preamble is clause `title`, matching Backline's chunker. `content_hash` is the sha256 of the clause body.
3. Ask Ollama for terms. Rates in the prompt examples are strings (`"0.30"`). Percentages in the PDF (`20%`) are supposed to come back as decimal strings (`"0.20"`).
4. Validate. A failure is printed with the extracted JSON and the file is not inserted.
5. For `kind: "amendment"`, ask: "This amendment replaces [sections]. Which base contract does it supersede?" The choices are `label.contracts` rows for the same artist with `kind = 'base'` and `effective_from` on or before the amendment. Bases from the same run are inserted first, so they appear in that list.
6. Insert the artist when the stage name is new, then the contract, terms, amendment row, and chunks. Chunk `embedding` and `embedding_model` are `NULL`.

A new artist needs `country` and `joined_at`. Contracts in this corpus usually state neither, so Patchbay asks. Matching an existing `stage_name` reuses that artist.

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
| `revenue_type` | `streaming`, `download`, `sync`, `physical`. Anything else, including `merch`, is rejected and shown for review. |
| `kind` | `base` or `amendment`. |
| Base sections | All three sections, and `replaced_sections` is `[]`. |
| Amendment sections | The section keys are exactly `replaced_sections`. An empty list, an unknown key, or an extra section fails. |
| Rate card | No duplicate `(revenue_type, territory)` pair. |

Base contracts here must include `term_territory`. Backline's parser treats that section as optional; requiring it keeps the stored JSON in the full shape and still passes `parse_terms_doc`.

`revenue_type` is the set observed in Backline's seed. If a future parser accepts a wider set, an unfamiliar type is reported and dropped from the insert, not silently removed from the card.

## Tests

```bash
npm test
npm run typecheck
```

`tests/parse.test.ts` reads one Backline PDF when the sibling `backline/data/contracts` tree is present.

## Verification

1. `psql "$DATABASE_URL" -c "SELECT 1"`
2. Startup log shows the next artist and contract ids, taken from `MAX(id)`.
3. A base PDF produces terms JSON and a `label.contract_terms` row.
4. An amendment PDF reports `replaced_sections`, waits for a base-contract choice, and writes `label.amendments`.
5. A float rate or an unknown section is rejected with no insert. `npm test` covers this without the model.
6. `rag.contract_chunks` rows for the new contract have `embedding IS NULL`.
7. After `make embed` (with the sidecar in place), `embedding` is populated.
8. Ask Backline's Counsel agent about the contract; it should retrieve those clauses.

## Limitations

Few-shot prompting is not fine-tuning. `llama3.2:3b` can still misread unusual language. Validation catches structural mistakes, not a wrong rate that is still a plausible string. Amendment review is mandatory.

Scanned PDFs are out of scope. Empty or garbage text is flagged and skipped. There is no OCR.

Section detection is a heuristic. Numbered Backline headings (`§3. ROYALTIES`) split cleanly. Other layouts fall back to heading text, and a heading that is not on its own line will not split.

`make embed` rebuilds chunks from txt sidecars and deletes database chunks it cannot see in those files. Set `BACKLINE_DATA_DIR` so the sidecar exists, or copy the extracted text to `{DATA_DIR}/contracts/txt/<stem>.txt` yourself. Patchbay does not generate embeddings, ingest statements, calculate royalties, or change Backline.

## Layout

```text
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
