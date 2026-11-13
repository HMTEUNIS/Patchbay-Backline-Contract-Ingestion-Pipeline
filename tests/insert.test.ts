import assert from "node:assert/strict";
import { test } from "node:test";

import { IdAllocator } from "../src/db.js";
import { insertContract, sidecarPath, type InsertPlan } from "../src/insert.js";
import { loadConfig } from "../src/config.js";
import { parseCli } from "../src/ingest.js";
import { parseTermsDoc, type TermsDoc } from "../src/validate.js";

function terms(): TermsDoc {
  return parseTermsDoc({
    meta: {
      contract_id: 9,
      artist_id: 3,
      kind: "base",
      effective_from: "2023-04-01",
      effective_to: null,
      replaced_sections: [],
    },
    sections: {
      term_territory: { excluded_territories: [] },
      royalties: {
        rate_card: [{ revenue_type: "streaming", territory: "WW", rate: "0.30" }],
        escalators: [],
      },
      advances_recoupment: {
        account: "AC-00009",
        recoupable_classes: ["recording"],
        minimum_guarantee_per_period: null,
      },
    },
  });
}

function plan(doc: TermsDoc): InsertPlan {
  return {
    newArtist: {
      id: 3,
      stageName: "Horizon",
      legalName: "Nikolai Kjeldsen",
      joinedAt: "2023-04-01",
      country: "DK",
    },
    contractId: 9,
    artistId: 3,
    docPath: "contracts/horizon.pdf",
    effectiveFrom: "2023-04-01",
    effectiveTo: null,
    kind: "base",
    terms: doc,
    supersedesContractId: null,
    chunks: [
      {
        clauseNo: "§3",
        part: 0,
        heading: "§3. ROYALTIES",
        content: "20% of Net Receipts from interactive audio streaming throughout the Territory;",
        contentHash: "abc",
        pageStart: 1,
        pageEnd: 1,
      },
    ],
  };
}

test("ids increment from the stored maximum and never use a default", () => {
  const ids = new IdAllocator(40, 800);
  assert.equal(ids.nextArtist(), 41);
  assert.equal(ids.nextArtist(), 42);
  assert.equal(ids.nextContract(), 801);
  assert.equal(ids.nextContract(), 802);
});

test("a float rate is rejected before any write", async () => {
  const doc = terms();
  const card = doc.sections.royalties?.rate_card[0];
  assert.ok(card);
  (card as { rate: unknown }).rate = 0.3;
  let writes = 0;
  await assert.rejects(
    () => insertContract({ query: async () => { writes += 1; } }, plan(doc)),
    /float/,
  );
  assert.equal(writes, 0);
});

test("a valid plan writes artists, contracts, terms, and chunks with null embeddings", async () => {
  const statements: string[] = [];
  await insertContract(
    {
      query: async (sql) => {
        statements.push(sql);
      },
    },
    plan(terms()),
  );
  assert.match(statements[0] ?? "", /INSERT INTO label\.artists/);
  assert.match(statements[1] ?? "", /INSERT INTO label\.contracts/);
  assert.match(statements[2] ?? "", /INSERT INTO label\.contract_terms/);
  assert.match(statements[3] ?? "", /INSERT INTO rag\.contract_chunks/);
  assert.match(statements[3] ?? "", /NULL, NULL/);
  assert.equal(statements.some((sql) => /DEFAULT/i.test(sql)), false);
  assert.equal(statements.some((sql) => /label\.amendments/.test(sql)), false);
});

test("an amendment write includes the confirmed base contract", async () => {
  const doc = parseTermsDoc({
    meta: {
      contract_id: 10,
      artist_id: 3,
      kind: "amendment",
      effective_from: "2025-06-01",
      effective_to: null,
      replaced_sections: ["royalties"],
    },
    sections: {
      royalties: {
        rate_card: [{ revenue_type: "streaming", territory: "WW", rate: "0.34" }],
        escalators: [],
      },
    },
  });
  const statements: { sql: string; params: unknown[] }[] = [];
  const amendment = plan(doc);
  amendment.contractId = 10;
  amendment.kind = "amendment";
  amendment.newArtist = null;
  amendment.supersedesContractId = 9;
  amendment.terms = doc;
  await insertContract(
    {
      query: async (sql, params) => {
        statements.push({ sql, params: params ?? [] });
      },
    },
    amendment,
  );
  const row = statements.find((statement) => /label\.amendments/.test(statement.sql));
  assert.ok(row);
  assert.deepEqual(row?.params.slice(0, 3), [10, 9, ["royalties"]]);
});

test("sidecar path matches the stem Backline's embed job reads", () => {
  assert.equal(
    sidecarPath("/data", "FBR-C-00501_maren-the-aurora.pdf"),
    "/data/contracts/txt/FBR-C-00501_maren-the-aurora.txt",
  );
});

test("config comes from the environment", () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://backline:backline@localhost:5432/backline",
    OLLAMA_HOST: "http://localhost:11434/",
    OLLAMA_MODEL: "llama3.2:3b",
  });
  assert.equal(config.databaseUrl, "postgresql://backline:backline@localhost:5432/backline");
  assert.equal(config.ollamaHost, "http://localhost:11434");
  assert.equal(config.ollamaModel, "llama3.2:3b");
  assert.equal(config.backlineDataDir, null);
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test("the CLI accepts a folder and dry-run", () => {
  assert.deepEqual(parseCli(["ingest", "./contracts", "--dry-run"]), {
    help: false,
    dryRun: true,
    folder: "./contracts",
  });
});
