/** Human confirmation for amendment supersession and fields the PDF does not state. */

import type { BaseContractRow } from "./db.js";
import { SECTION_KEYS, type SectionKey } from "./validate.js";

export type Prompter = (question: string) => Promise<string>;

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export type SupersessionDecision =
  | { action: "confirmed"; supersedesContractId: number }
  | { action: "skip" };

const SECTION_SET = new Set<string>(SECTION_KEYS);

export async function confirmKind(prompter: Prompter, reviewNote: string): Promise<"base" | "amendment" | "skip"> {
  const note = reviewNote.trim();
  let question = [
    "Kind is ambiguous, so this file defaults to base.",
    note ? `Extractor note: ${note}` : "",
    "Type base, amendment, or skip:",
  ]
    .filter(Boolean)
    .join("\n");
  for (;;) {
    const answer = (await prompter(`${question}\n> `)).trim().toLowerCase();
    if (answer === "base" || answer === "amendment" || answer === "skip") return answer;
    question = "Enter base, amendment, or skip:";
  }
}

export async function confirmReplacedSections(
  prompter: Prompter,
  proposed: readonly string[],
  reviewNote: string,
): Promise<SectionKey[] | "skip"> {
  const note = reviewNote.trim();
  const proposedLabel = proposed.length > 0 ? proposed.join(", ") : "(none)";
  let question = [
    "The extractor could not determine which sections this amendment replaces.",
    `Proposed: ${proposedLabel}`,
    note ? `Extractor note: ${note}` : "",
    `Enter a comma-separated list (${SECTION_KEYS.join(", ")}), or skip:`,
  ]
    .filter(Boolean)
    .join("\n");
  for (;;) {
    const answer = (await prompter(`${question}\n> `)).trim();
    if (answer.toLowerCase() === "skip") return "skip";
    const parts = answer
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0 && parts.every((part) => SECTION_SET.has(part))) {
      return [...new Set(parts)] as SectionKey[];
    }
    question = `Use only ${SECTION_KEYS.join(", ")}, or skip:`;
  }
}

export async function confirmSupersession(
  prompter: Prompter,
  input: { replacedSections: readonly string[]; candidates: readonly BaseContractRow[] },
): Promise<SupersessionDecision> {
  const sections = input.replacedSections.join(", ");
  if (input.candidates.length === 0) {
    throw new ReviewError(
      `This amendment replaces ${sections}. No base contract for this artist has effective_from on or before the amendment. It was not inserted.`,
    );
  }
  const lines = input.candidates.map((candidate, index) => {
    const until = candidate.effectiveTo ?? "open";
    return `  ${index + 1}) id=${candidate.id}  effective ${candidate.effectiveFrom} .. ${until}\n     ${candidate.docPath}`;
  });
  const question = [
    `This amendment replaces ${sections}. Which base contract does it supersede?`,
    "",
    ...lines,
    "",
    "Enter a number, or skip:",
  ].join("\n");
  for (;;) {
    const answer = (await prompter(`${question}\n> `)).trim().toLowerCase();
    if (answer === "skip") return { action: "skip" };
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= input.candidates.length) {
      const selected = input.candidates[choice - 1];
      if (!selected) continue;
      return { action: "confirmed", supersedesContractId: selected.id };
    }
  }
}

export async function confirmArtistFields(
  prompter: Prompter,
  artist: { stageName: string; country: string | null; joinedAt: string | null },
  suggestedJoinedAt: string | null,
): Promise<{ country: string; joinedAt: string } | "skip"> {
  let country = normalizeCountry(artist.country);
  let joinedAt = isIsoDate(artist.joinedAt) ? artist.joinedAt : null;

  if (!country) {
    const hint = artist.country?.trim() ? ` Extractor suggested "${artist.country.trim()}".` : "";
    for (;;) {
      const answer = (
        await prompter(
          `No country code for new artist ${artist.stageName}.${hint} Enter an ISO-2 code, or skip:\n> `,
        )
      ).trim();
      if (answer.toLowerCase() === "skip") return "skip";
      const normalized = normalizeCountry(answer);
      if (normalized) {
        country = normalized;
        break;
      }
    }
  }

  if (!joinedAt) {
    const suggestion = suggestedJoinedAt
      ? ` Enter YYYY-MM-DD (suggested ${suggestedJoinedAt}; blank accepts it), or skip:`
      : " Enter YYYY-MM-DD, or skip:";
    for (;;) {
      const answer = (
        await prompter(`No joined_at for new artist ${artist.stageName}.${suggestion}\n> `)
      ).trim();
      if (answer.toLowerCase() === "skip") return "skip";
      const chosen = answer === "" ? suggestedJoinedAt : answer;
      if (isIsoDate(chosen)) {
        joinedAt = chosen;
        break;
      }
    }
  }

  return { country, joinedAt };
}

export function applyReplacedSections(
  sections: Record<string, unknown>,
  replaced: readonly SectionKey[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of replaced) {
    const value = sections[key];
    if (value == null) {
      throw new ReviewError(
        `No extracted ${key} section to keep. This amendment was not inserted.`,
      );
    }
    next[key] = value;
  }
  return next;
}

function normalizeCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
