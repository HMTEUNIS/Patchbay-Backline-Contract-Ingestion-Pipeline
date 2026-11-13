import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt, EXTRACTION_SCHEMA, readModelExtraction } from "../src/extract.js";

test("few-shot prompt shows string rates for a base and an amendment", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /Rates are STRINGS/);
  assert.match(prompt, /"rate": "0\.30"/);
  assert.match(prompt, /"rate": "0\.34"/);
  assert.match(prompt, /EXAMPLE 1 — Base contract/);
  assert.match(prompt, /EXAMPLE 2 — Amendment/);
  assert.match(prompt, /"replaced_sections": \[\s*"royalties"\s*\]/);
  assert.doesNotMatch(prompt, /"rate": 0\.\d+/);
});

test("structured output schema keeps rate a string", () => {
  const royalties = EXTRACTION_SCHEMA.properties.sections.properties.royalties;
  assert.equal(royalties.properties.rate_card.items.properties.rate.type, "string");
});

test("reads a model envelope and drops null sections", () => {
  const extraction = readModelExtraction({
    artist: { stage_name: "Horizon", legal_name: "Nikolai Kjeldsen", country: null, joined_at: null },
    meta: {
      kind: "amendment",
      effective_from: "2026-03-14",
      effective_to: null,
      replaced_sections: ["royalties"],
    },
    sections: {
      royalties: {
        rate_card: [{ revenue_type: "streaming", territory: "WW", rate: "0.36" }],
        escalators: [],
      },
      term_territory: null,
    },
    kind_uncertain: false,
    replaced_sections_uncertain: false,
    review_note: "",
  });
  assert.equal(extraction.meta.kind, "amendment");
  assert.deepEqual(Object.keys(extraction.sections), ["royalties"]);
  assert.equal(extraction.artist.stageName, "Horizon");
});
