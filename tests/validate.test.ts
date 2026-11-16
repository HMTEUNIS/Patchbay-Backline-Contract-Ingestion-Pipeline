import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTermsDoc, TermsValidationError } from "../src/validate.js";

function baseDoc(): Record<string, unknown> {
  return {
    meta: {
      contract_id: 101,
      artist_id: 7,
      kind: "base",
      effective_from: "2023-04-01",
      effective_to: null,
      replaced_sections: [],
    },
    sections: {
      term_territory: { excluded_territories: [] },
      royalties: {
        rate_card: [
          { revenue_type: "streaming", territory: "WW", rate: "0.30" },
          { revenue_type: "physical", territory: "GB", rate: "0.15" },
          { revenue_type: "download", territory: "WW", rate: "0.21" },
          { revenue_type: "sync", territory: "WW", rate: "0.46" },
        ],
        escalators: [{ threshold_usd: "250000", bump: "0.02" }],
      },
      advances_recoupment: {
        account: "AC-00501",
        recoupable_classes: ["recording", "video"],
        minimum_guarantee_per_period: null,
      },
    },
  };
}

function amendmentDoc(): Record<string, unknown> {
  return {
    meta: {
      contract_id: 501,
      artist_id: 7,
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
  };
}

test("accepts a base contract with string rates", () => {
  const doc = parseTermsDoc(baseDoc());
  assert.equal(doc.meta.kind, "base");
  assert.equal(doc.meta.replaced_sections.length, 0);
  assert.equal(doc.sections.royalties?.rate_card[0]?.rate, "0.30");
  assert.equal(doc.sections.advances_recoupment?.account, "AC-00501");
});

test("accepts an amendment whose sections match replaced_sections", () => {
  const doc = parseTermsDoc(amendmentDoc());
  assert.deepEqual(doc.meta.replaced_sections, ["royalties"]);
  assert.deepEqual(Object.keys(doc.sections), ["royalties"]);
});

test("rejects a float rate before it could be inserted", () => {
  const bad = baseDoc();
  const sections = bad["sections"] as { royalties: { rate_card: { rate: unknown }[] } };
  sections.royalties.rate_card[0]!.rate = 0.3;
  assert.throws(() => parseTermsDoc(bad), (err: unknown) => {
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /float/);
    return true;
  });
});

test("rejects an unknown revenue type instead of dropping it", () => {
  const bad = baseDoc();
  const sections = bad["sections"] as { royalties: { rate_card: { revenue_type: string }[] } };
  sections.royalties.rate_card[0]!.revenue_type = "merch";
  assert.throws(() => parseTermsDoc(bad), (err: unknown) => {
    assert.ok(err instanceof TermsValidationError);
    assert.match(err.message, /merch/);
    return true;
  });
});

test("rejects an unknown section, an unknown kind, and a rate outside [0, 1]", () => {
  const unknownSection = baseDoc();
  (unknownSection["sections"] as Record<string, unknown>)["merchandising"] = {};
  assert.throws(() => parseTermsDoc(unknownSection), /merchandising/);

  const unknownKind = baseDoc();
  (unknownKind["meta"] as { kind: string }).kind = "sidedeal";
  assert.throws(() => parseTermsDoc(unknownKind), /sidedeal/);

  const negative = baseDoc();
  const negCard = (negative["sections"] as { royalties: { rate_card: { rate: string }[] } }).royalties
    .rate_card;
  negCard[0]!.rate = "-0.10";
  assert.throws(() => parseTermsDoc(negative), /rate/);

  const tooHigh = baseDoc();
  const highCard = (tooHigh["sections"] as { royalties: { rate_card: { rate: string }[] } }).royalties
    .rate_card;
  highCard[0]!.rate = "1.01";
  assert.throws(() => parseTermsDoc(tooHigh), /rate/);
});

test("accepts a whole-number amount and strips thousands separators", () => {
  const whole = baseDoc();
  (
    whole["sections"] as { advances_recoupment: { minimum_guarantee_per_period: string } }
  ).advances_recoupment.minimum_guarantee_per_period = "1500";
  assert.equal(parseTermsDoc(whole).sections.advances_recoupment?.minimum_guarantee_per_period, "1500");

  const commas = baseDoc();
  (
    commas["sections"] as { advances_recoupment: { minimum_guarantee_per_period: string } }
  ).advances_recoupment.minimum_guarantee_per_period = "1,500.00";
  (
    commas["sections"] as { royalties: { escalators: { threshold_usd: string }[] } }
  ).royalties.escalators[0]!.threshold_usd = "250,000";
  const doc = parseTermsDoc(commas);
  assert.equal(doc.sections.advances_recoupment?.minimum_guarantee_per_period, "1500.00");
  assert.equal(doc.sections.royalties?.escalators[0]?.threshold_usd, "250000");
});

test("rejects duplicate rate-card pairs and a non-decimal rate", () => {
  const duplicate = baseDoc();
  const card = (duplicate["sections"] as { royalties: { rate_card: object[] } }).royalties.rate_card;
  card.push({ ...card[0] });
  assert.throws(() => parseTermsDoc(duplicate), /duplicate/);

  const garbage = baseDoc();
  (garbage["sections"] as { royalties: { rate_card: { rate: string }[] } }).royalties.rate_card[0]!.rate =
    "thirty percent";
  assert.throws(() => parseTermsDoc(garbage), /not a decimal/);
});

test("rejects a base contract that replaces sections or drops a required section", () => {
  const replaced = baseDoc();
  (replaced["meta"] as { replaced_sections: string[] }).replaced_sections = ["royalties"];
  assert.throws(() => parseTermsDoc(replaced), /base contracts do not replace/);

  const missing = baseDoc();
  delete (missing["sections"] as { term_territory?: unknown }).term_territory;
  assert.throws(() => parseTermsDoc(missing), /term_territory/);
});

test("rejects an amendment with empty, unknown, or extra sections", () => {
  const empty = amendmentDoc();
  (empty["meta"] as { replaced_sections: string[] }).replaced_sections = [];
  assert.throws(() => parseTermsDoc(empty), /replaced_sections/);

  const unknown = amendmentDoc();
  (unknown["meta"] as { replaced_sections: string[] }).replaced_sections = ["appendix"];
  (unknown["sections"] as Record<string, unknown>)["appendix"] = {};
  delete (unknown["sections"] as { royalties?: unknown }).royalties;
  assert.throws(() => parseTermsDoc(unknown), /appendix/);

  const extra = amendmentDoc();
  (extra["sections"] as Record<string, unknown>)["term_territory"] = { excluded_territories: [] };
  assert.throws(() => parseTermsDoc(extra), /match replaced_sections/);
});

test("accepts a rate of 0 and 1 and an integer escalator threshold", () => {
  const doc = baseDoc();
  const royalties = (doc["sections"] as { royalties: { rate_card: { rate: string }[]; escalators: { threshold_usd: unknown }[] } })
    .royalties;
  royalties.rate_card[0]!.rate = "0";
  royalties.rate_card[1]!.rate = "1";
  royalties.escalators[0]!.threshold_usd = 250000;
  const parsed = parseTermsDoc(doc);
  assert.equal(parsed.sections.royalties?.escalators[0]?.threshold_usd, "250000");
});
