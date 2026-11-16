/**
 * Few-shot extraction through Ollama structured outputs.
 * The schema forces JSON; parseTermsDoc still has to accept the meaning.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PageText } from "./parse.js";

export type ModelExtraction = {
  artist: {
    stageName: string;
    legalName: string;
    country: string | null;
    joinedAt: string | null;
  };
  meta: {
    kind: "base" | "amendment";
    effectiveFrom: string;
    effectiveTo: string | null;
    replacedSections: string[];
  };
  sections: Record<string, unknown>;
  kindUncertain: boolean;
  replacedSectionsUncertain: boolean;
  reviewNote: string;
};

type ExampleFile = {
  input: string;
  output: unknown;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** CPU inference of a full terms document often exceeds three minutes. */
export const EXTRACTION_TIMEOUT_MS = 15 * 60 * 1000;

export function loadExamples(): { base: ExampleFile; amendment: ExampleFile } {
  return {
    base: readJson(resolve(ROOT, "prompts/base-example.json")),
    amendment: readJson(resolve(ROOT, "prompts/amendment-example.json")),
  };
}

export function buildSystemPrompt(examples = loadExamples()): string {
  return `You are extracting structured contract terms from music industry contracts.

Output must match this exact JSON structure. Rates are STRINGS (e.g., "0.30", not 0.30).

EXAMPLE 1 — Base contract:
Input: "${examples.base.input}"
Output: ${JSON.stringify(examples.base.output, null, 2)}

EXAMPLE 2 — Amendment (replaces only royalties section):
Input: "${examples.amendment.input}"
Output: ${JSON.stringify(examples.amendment.output, null, 2)}

Return one JSON object with "artist", "meta", "sections", "kind_uncertain", "replaced_sections_uncertain", and "review_note".
"meta" and "sections" follow the examples. Do not invent contract_id or artist_id.

Rules:
- kind is "base" for an agreement and "amendment" for an amendment. If the title or preamble is ambiguous, set kind to "base", kind_uncertain to true, and explain why in review_note.
- effective_from and effective_to are ISO dates YYYY-MM-DD. "April 23, 2023" is "2023-04-23". effective_to is null when the term is open-ended.
- Percentages in the source are decimal strings in [0, 1]: 20% is "0.20", 15% is "0.15", a 2 percentage-point escalator bump is "0.02". Never emit a JSON number and never emit a percent sign.
- revenue_type is streaming (interactive audio streaming), download (permanent digital downloads), sync (synchronization licensing), or physical (physical product). If the contract uses a type outside that set, still include it so a person can review it.
- territory is "WW" for throughout the Territory or a worldwide rate, otherwise the ISO-2 code in the clause (GB, US, JP, DE).
- excluded_territories lists places the agreement excludes ("world EXCLUDING JP" is ["JP"]). Use [] when the territory is the world.
- replaced_sections maps amended clauses to bare keys: §2 Term and Territory is term_territory, §3 Royalties is royalties, §4 Advances and Recoupment is advances_recoupment.
- A base contract includes all three sections and replaced_sections [].
- An amendment includes exactly the replaced sections and no others. If you cannot tell which sections are replaced, set replaced_sections_uncertain to true, replaced_sections to [], and sections to {}. Do not guess.
- account is the recoupment account designation (AC-##### or XC-####). recoupable_classes are the named classes, such as recording, video, and tour_support. minimum_guarantee_per_period is a decimal string or null. Escalator threshold_usd is the dollar amount as a string ("250000") and bump is a decimal string. Use [] when there is no escalation.
- A comma in a dollar amount is a thousands separator, never a decimal point. US $1,500.00 is "1500.00", not "1.50". US $250,000.00 is "250000.00". Omit an escalator or guarantee the document does not state.
- artist.stage_name is the professional name and artist.legal_name is the legal name, copied without surrounding quotes. country is an ISO-2 code only when the document states one, otherwise null. joined_at is YYYY-MM-DD only when the document states when the artist joined, otherwise null.
- Copy only facts that appear in the document. Page markers are citations, not contract text.`;
}

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "artist",
    "meta",
    "sections",
    "kind_uncertain",
    "replaced_sections_uncertain",
    "review_note",
  ],
  properties: {
    artist: {
      type: "object",
      additionalProperties: false,
      required: ["stage_name", "legal_name", "country", "joined_at"],
      properties: {
        stage_name: { type: "string" },
        legal_name: { type: "string" },
        country: { type: ["string", "null"] },
        joined_at: { type: ["string", "null"] },
      },
    },
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "effective_from", "effective_to", "replaced_sections"],
      properties: {
        kind: { type: "string", enum: ["base", "amendment"] },
        effective_from: { type: "string" },
        effective_to: { type: ["string", "null"] },
        replaced_sections: {
          type: "array",
          items: {
            type: "string",
            enum: ["term_territory", "royalties", "advances_recoupment"],
          },
        },
      },
    },
    sections: {
      type: "object",
      additionalProperties: false,
      properties: {
        term_territory: {
          type: "object",
          additionalProperties: false,
          required: ["excluded_territories"],
          properties: {
            excluded_territories: { type: "array", items: { type: "string" } },
          },
        },
        royalties: {
          type: "object",
          additionalProperties: false,
          required: ["rate_card", "escalators"],
          properties: {
            rate_card: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["revenue_type", "territory", "rate"],
                properties: {
                  revenue_type: { type: "string" },
                  territory: { type: "string" },
                  rate: { type: "string" },
                },
              },
            },
            escalators: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["threshold_usd", "bump"],
                properties: {
                  threshold_usd: { type: "string" },
                  bump: { type: "string" },
                },
              },
            },
          },
        },
        advances_recoupment: {
          type: "object",
          additionalProperties: false,
          required: ["account", "recoupable_classes", "minimum_guarantee_per_period"],
          properties: {
            account: { type: "string" },
            recoupable_classes: { type: "array", items: { type: "string" } },
            minimum_guarantee_per_period: { type: ["string", "null"] },
          },
        },
      },
    },
    kind_uncertain: { type: "boolean" },
    replaced_sections_uncertain: { type: "boolean" },
    review_note: { type: "string" },
  },
} as const;

export function pageMarkedText(pages: readonly PageText[]): string {
  return pages.map((page) => `--- page ${page.page} ---\n${page.text.trim()}`).join("\n\n");
}

export async function assertOllamaReady(host: string, model: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${host}/api/tags`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Ollama at ${host}. Start Ollama and pull ${model}. ${detail}`);
  }
  if (!response.ok) {
    throw new Error(`Ollama at ${host} returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { models?: { name?: string }[] };
  const names = (body.models ?? []).map((item) => item.name ?? "").filter(Boolean);
  const ready = names.some((name) => name === model || name.startsWith(`${model}-`));
  if (!ready) {
    throw new Error(
      `Ollama is up but ${model} is not pulled (have: ${names.join(", ") || "none"}). Run: ollama pull ${model}`,
    );
  }
}

export async function extractContract(input: {
  host: string;
  model: string;
  fileName: string;
  pages: readonly PageText[];
  fetchImpl?: typeof fetch;
}): Promise<ModelExtraction> {
  const fetcher = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${input.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        format: EXTRACTION_SCHEMA,
        keep_alive: "30m",
        options: { temperature: 0, num_ctx: 8192 },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content: `Extract the contract in ${input.fileName}.\n\n${pageMarkedText(input.pages)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeout(err)) {
      const minutes = EXTRACTION_TIMEOUT_MS / 60_000;
      throw new Error(
        `Ollama did not finish within ${minutes} minutes. On CPU, ${input.model} often needs several minutes per contract. Rerun while the model is still loaded.`,
      );
    }
    throw err;
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama extraction failed (HTTP ${response.status}): ${detail.slice(0, 500)}`);
  }
  const body = (await response.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(`Ollama extraction failed: ${body.error}`);
  const content = body.message?.content;
  if (!content) throw new Error("Ollama returned an empty extraction.");
  return readModelExtraction(parseModelJson(content));
}

export function parseModelJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama output is not JSON: ${detail}`);
  }
}

export function readModelExtraction(value: unknown): ModelExtraction {
  const root = asRecord(value, "model output");
  const envelope = asRecord(root["meta"] ? root : root["output"], "model output");
  const artist = asRecord(envelope["artist"], "artist");
  const meta = asRecord(envelope["meta"], "meta");
  const sectionsIn = asRecord(envelope["sections"], "sections");
  const kind = meta["kind"];
  if (kind !== "base" && kind !== "amendment") {
    throw new Error(`model kind must be base or amendment, got ${JSON.stringify(kind)}`);
  }
  const stageName = requiredString(artist["stage_name"], "artist.stage_name");
  const legalName = requiredString(artist["legal_name"], "artist.legal_name");
  if (stageName === "" || legalName === "") {
    throw new Error("model output is missing the artist stage name or legal name");
  }
  const replaced = meta["replaced_sections"];
  if (!Array.isArray(replaced) || replaced.some((item) => typeof item !== "string")) {
    throw new Error("model replaced_sections must be an array of strings");
  }
  const sections: Record<string, unknown> = {};
  for (const [key, section] of Object.entries(sectionsIn)) {
    if (section != null) sections[key] = section;
  }
  return {
    artist: {
      stageName,
      legalName,
      country: nullableString(artist["country"]),
      joinedAt: nullableString(artist["joined_at"]),
    },
    meta: {
      kind,
      effectiveFrom: requiredString(meta["effective_from"], "effective_from"),
      effectiveTo: nullableString(meta["effective_to"]),
      replacedSections: replaced,
    },
    sections,
    kindUncertain: envelope["kind_uncertain"] === true,
    replacedSectionsUncertain: envelope["replaced_sections_uncertain"] === true,
    reviewNote: typeof envelope["review_note"] === "string" ? envelope["review_note"] : "",
  };
}

function readJson(path: string): ExampleFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ExampleFile;
  if (typeof parsed.input !== "string" || parsed.output == null) {
    throw new Error(`Prompt example ${path} must have input and output.`);
  }
  return parsed;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim();
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
