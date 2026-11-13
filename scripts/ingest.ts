import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runIngest } from "../src/ingest.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: resolve(root, ".env") });

let code = 1;
try {
  code = await runIngest(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  code = 1;
}
process.exit(code);
