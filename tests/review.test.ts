import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyReplacedSections,
  confirmArtistFields,
  confirmReplacedSections,
  confirmSupersession,
  ReviewError,
} from "../src/review.js";

const candidates = [
  {
    id: 501,
    docPath: "data/contracts/FBR-C-00501_maren.pdf",
    effectiveFrom: "2023-04-01",
    effectiveTo: null,
  },
  {
    id: 502,
    docPath: "data/contracts/FBR-C-00502_maren.pdf",
    effectiveFrom: "2024-01-01",
    effectiveTo: "2025-01-01",
  },
];

test("asks which base contract an amendment supersedes", async () => {
  const questions: string[] = [];
  const decision = await confirmSupersession(
    async (question) => {
      questions.push(question);
      return "2";
    },
    { replacedSections: ["royalties"], candidates },
  );
  assert.deepEqual(decision, { action: "confirmed", supersedesContractId: 502 });
  assert.match(
    questions[0] ?? "",
    /This amendment replaces royalties\. Which base contract does it supersede\?/,
  );
  assert.match(questions[0] ?? "", /id=501/);
  assert.match(questions[0] ?? "", /id=502/);
});

test("skip leaves the amendment unconfirmed", async () => {
  const decision = await confirmSupersession(async () => "skip", {
    replacedSections: ["royalties", "term_territory"],
    candidates,
  });
  assert.deepEqual(decision, { action: "skip" });
});

test("an amendment with no eligible base contract is not inserted", async () => {
  await assert.rejects(
    () => confirmSupersession(async () => "1", { replacedSections: ["royalties"], candidates: [] }),
    ReviewError,
  );
});

test("replaced sections must be named explicitly", async () => {
  const answers = ["nope", "royalties, advances_recoupment"];
  const confirmed = await confirmReplacedSections(async () => answers.shift() ?? "", [], "unsure");
  assert.deepEqual(confirmed, ["royalties", "advances_recoupment"]);
});

test("trimming to confirmed sections refuses a missing payload", () => {
  assert.throws(
    () => applyReplacedSections({ royalties: { rate_card: [] } }, ["royalties", "term_territory"]),
    /term_territory/,
  );
  const kept = applyReplacedSections(
    { royalties: { rate_card: [] }, term_territory: { excluded_territories: [] } },
    ["royalties"],
  );
  assert.deepEqual(Object.keys(kept), ["royalties"]);
});

test("asks for a country and joined date when the PDF does not state them", async () => {
  const answers = ["us", ""];
  const confirmed = await confirmArtistFields(
    async () => answers.shift() ?? "",
    { stageName: "Maren & The Aurora", country: null, joinedAt: null },
    "2023-04-23",
  );
  assert.deepEqual(confirmed, { country: "US", joinedAt: "2023-04-23" });
});
