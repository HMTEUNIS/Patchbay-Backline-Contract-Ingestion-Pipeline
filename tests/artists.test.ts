import assert from "node:assert/strict";
import { test } from "node:test";

import { artistKey, matchArtists } from "../src/artists.js";

test("stage-name matching folds case, quotes, and surrounding space", () => {
  assert.equal(artistKey("  The Weeknd  "), artistKey("the weeknd"));
  assert.equal(artistKey("“Horizon”"), artistKey('"Horizon"'));
  assert.equal(artistKey("Maren   &   The Aurora"), artistKey("maren & the aurora"));
});

test("one normalized stage name reuses that artist, and two matches stay ambiguous", () => {
  const rows = [
    { id: 1, stageName: "The Weeknd" },
    { id: 2, stageName: "Horizon" },
    { id: 3, stageName: "horizon " },
  ];
  assert.deepEqual(
    matchArtists(rows, "the weeknd").map((row) => row.id),
    [1],
  );
  assert.deepEqual(
    matchArtists(rows, "HORIZON").map((row) => row.id),
    [2, 3],
  );
  assert.deepEqual(matchArtists(rows, "Umbra"), []);
});
