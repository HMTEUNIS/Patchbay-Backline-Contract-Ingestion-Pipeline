import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceRelativePath } from "../src/sources.js";

test("sorts a contract PDF by artist and kind", () => {
  assert.equal(
    sourceRelativePath("FBR-A-02001_maren-the-aurora.pdf"),
    "maren-the-aurora/amendments/FBR-A-02001_maren-the-aurora.pdf",
  );
  assert.equal(
    sourceRelativePath("FBR-C-00501_maren-the-aurora.pdf"),
    "maren-the-aurora/base/FBR-C-00501_maren-the-aurora.pdf",
  );
  assert.equal(
    sourceRelativePath("PB-A-0001_nova-hale.pdf"),
    "nova-hale/amendments/PB-A-0001_nova-hale.pdf",
  );
  assert.equal(sourceRelativePath("notes.pdf"), "unsorted/notes.pdf");
});
