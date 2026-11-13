/**
 * Backline's parse_terms_doc rules (royaltycalc/terms.py and tests/royaltycalc/test_terms.py).
 *
 * A document that passes here is safe to store in label.contract_terms. Rates stay strings.
 * Base contracts must carry all three sections; Backline's parser treats term_territory as
 * optional, and this check is stricter so an ingested base always has the full shape.
 */

export const REVENUE_TYPES = ["streaming", "download", "physical", "sync"] as const;
export const SECTION_KEYS = ["term_territory", "royalties", "advances_recoupment"] as const;
export const KINDS = ["base", "amendment"] as const;

export type RevenueType = (typeof REVENUE_TYPES)[number];
export type SectionKey = (typeof SECTION_KEYS)[number];
export type ContractKind = (typeof KINDS)[number];

const REVENUE_TYPE_SET = new Set<string>(REVENUE_TYPES);
const SECTION_KEY_SET = new Set<string>(SECTION_KEYS);
const KIND_SET = new Set<string>(KINDS);

export type RateCardEntry = {
  revenue_type: string;
  territory: string;
  rate: string;
};

export type Escalator = {
  threshold_usd: string;
  bump: string;
};

export type TermsDoc = {
  meta: {
    contract_id: number;
    artist_id: number;
    kind: ContractKind;
    effective_from: string;
    effective_to: string | null;
    replaced_sections: SectionKey[];
  };
  sections: {
    term_territory?: { excluded_territories: string[] };
    royalties?: { rate_card: RateCardEntry[]; escalators: Escalator[] };
    advances_recoupment?: {
      account: string;
      recoupable_classes: string[];
      minimum_guarantee_per_period: string | null;
    };
  };
};

export class TermsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermsValidationError";
  }
}

export function parseTermsDoc(value: unknown): TermsDoc {
  const obj = record(value, "terms document");
  const meta = record(obj["meta"], "meta");
  const kind = meta["kind"];
  if (!isKind(kind)) {
    throw new TermsValidationError(`unknown contract kind ${quote(kind)}`);
  }

  const sectionsIn = record(obj["sections"], "sections");
  const sections: TermsDoc["sections"] = {};
  for (const key of Object.keys(sectionsIn)) {
    if (!SECTION_KEY_SET.has(key)) {
      throw new TermsValidationError(`unknown section ${quote(key)}`);
    }
    const section = sectionsIn[key];
    if (key === "term_territory") {
      sections.term_territory = readTerritory(section);
    } else if (key === "royalties") {
      sections.royalties = readRoyalties(section);
    } else {
      sections.advances_recoupment = readAdvances(section);
    }
  }

  const replaced = readReplaced(meta["replaced_sections"]);
  if (kind === "base") {
    if (replaced.length > 0) {
      throw new TermsValidationError("base contracts do not replace sections");
    }
    for (const required of SECTION_KEYS) {
      if (!(required in sections)) {
        throw new TermsValidationError(`base contract missing required section ${quote(required)}`);
      }
    }
  } else {
    if (replaced.length === 0) {
      throw new TermsValidationError("amendment must name replaced_sections");
    }
    for (const key of replaced) {
      if (!SECTION_KEY_SET.has(key)) {
        throw new TermsValidationError(`unknown replaced section ${quote(key)}`);
      }
      if (!(key in sections)) {
        throw new TermsValidationError(
          `amendment replaces ${quote(key)} but carries no such section`,
        );
      }
    }
    const present = Object.keys(sections);
    const expected = new Set<string>(replaced);
    if (present.length !== expected.size || present.some((key) => !expected.has(key))) {
      throw new TermsValidationError("amendment sections must match replaced_sections exactly");
    }
  }

  return {
    meta: {
      contract_id: readId(meta["contract_id"], "contract_id"),
      artist_id: readId(meta["artist_id"], "artist_id"),
      kind,
      effective_from: readIsoDate(meta["effective_from"], "effective_from"),
      effective_to: readOptionalDate(meta["effective_to"]),
      replaced_sections: replaced,
    },
    sections,
  };
}

function readTerritory(value: unknown): { excluded_territories: string[] } {
  const section = record(value, "term_territory");
  const excluded = section["excluded_territories"] ?? [];
  if (!Array.isArray(excluded) || excluded.some((item) => typeof item !== "string")) {
    throw new TermsValidationError("excluded_territories must be strings");
  }
  return { excluded_territories: excluded };
}

function readRoyalties(value: unknown): { rate_card: RateCardEntry[]; escalators: Escalator[] } {
  const section = record(value, "royalties");
  if (!Array.isArray(section["rate_card"])) {
    throw new TermsValidationError("royalties.rate_card is required");
  }
  const seen = new Set<string>();
  const rateCard: RateCardEntry[] = [];
  for (const entry of section["rate_card"]) {
    const row = record(entry, "rate card entry");
    const revenueType = row["revenue_type"];
    if (typeof revenueType !== "string" || !REVENUE_TYPE_SET.has(revenueType)) {
      throw new TermsValidationError(`unknown revenue_type ${quote(revenueType)}`);
    }
    const territory = row["territory"];
    if (typeof territory !== "string" || territory === "") {
      throw new TermsValidationError(`bad territory ${quote(territory)}`);
    }
    const rate = readDecimal(row["rate"], "rate");
    if (cmpDecimal(rate, "0") < 0 || cmpDecimal(rate, "1") > 0) {
      throw new TermsValidationError(`rate out of range [0, 1]: ${rate}`);
    }
    const key = `${revenueType}\0${territory}`;
    if (seen.has(key)) {
      throw new TermsValidationError(`duplicate rate card entry for (${revenueType}, ${territory})`);
    }
    seen.add(key);
    rateCard.push({ revenue_type: revenueType, territory, rate });
  }

  const rawEscalators = section["escalators"] ?? [];
  if (!Array.isArray(rawEscalators)) {
    throw new TermsValidationError("royalties.escalators must be an array");
  }
  const escalators: Escalator[] = [];
  for (const esc of rawEscalators) {
    const row = record(esc, "escalator");
    const threshold = readDecimal(row["threshold_usd"], "threshold_usd");
    if (cmpDecimal(threshold, "0") < 0) {
      throw new TermsValidationError("escalator threshold_usd must be >= 0");
    }
    const bump = readDecimal(row["bump"], "bump");
    if (cmpDecimal(bump, "0") < 0) {
      throw new TermsValidationError("escalator bump must be >= 0");
    }
    escalators.push({ threshold_usd: threshold, bump });
  }
  return { rate_card: rateCard, escalators };
}

function readAdvances(value: unknown): TermsDoc["sections"]["advances_recoupment"] {
  const section = record(value, "advances_recoupment");
  const account = section["account"];
  if (typeof account !== "string" || account === "") {
    throw new TermsValidationError(`bad recoupment account ${quote(account)}`);
  }
  const classes = section["recoupable_classes"];
  if (!Array.isArray(classes) || classes.some((item) => typeof item !== "string")) {
    throw new TermsValidationError("recoupable_classes must be strings");
  }
  const mg = section["minimum_guarantee_per_period"] ?? null;
  let minimum: string | null = null;
  if (mg !== null) {
    minimum = readDecimal(mg, "minimum_guarantee_per_period");
    if (cmpDecimal(minimum, "0") < 0) {
      throw new TermsValidationError("minimum_guarantee_per_period must be >= 0");
    }
  }
  return {
    account,
    recoupable_classes: classes,
    minimum_guarantee_per_period: minimum,
  };
}

function isKind(value: unknown): value is ContractKind {
  return typeof value === "string" && KIND_SET.has(value);
}

function readReplaced(value: unknown): SectionKey[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new TermsValidationError("replaced_sections must be an array");
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new TermsValidationError(`unknown replaced section ${quote(item)}`);
    }
    return item as SectionKey;
  });
}

function readId(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new TermsValidationError(`${field} must be an integer`);
}

function readOptionalDate(value: unknown): string | null {
  if (value == null) return null;
  return readIsoDate(value, "effective_to");
}

function readIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TermsValidationError(`${field} must be YYYY-MM-DD`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TermsValidationError(`${field} is not a real date: ${value}`);
  }
  return value;
}

function readDecimal(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (field === "rate" || !Number.isInteger(value)) {
      throw new TypeError(`${field}: decimal quantities must be strings in terms JSON, not float`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (!isDecimalString(value)) {
      throw new TermsValidationError(`${field}: not a decimal: ${quote(value)}`);
    }
    return value;
  }
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  throw new TypeError(`${field}: cannot read ${kind} as Decimal`);
}

function isDecimalString(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
}

/** Compare two decimal strings. Returns -1, 0, or 1. */
export function cmpDecimal(a: string, b: string): number {
  const left = scale(a);
  const right = scale(b);
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0 || right.sign === 0) {
    if (left.sign === 0 && right.sign === 0) return 0;
    return left.sign < right.sign ? -1 : 1;
  }
  const digits = Math.max(left.frac.length, right.frac.length);
  const l = left.whole + left.frac.padEnd(digits, "0");
  const r = right.whole + right.frac.padEnd(digits, "0");
  const lInt = BigInt(l);
  const rInt = BigInt(r);
  if (lInt === rInt) return 0;
  const cmp = lInt < rInt ? -1 : 1;
  return left.sign < 0 ? -cmp : cmp;
}

function scale(value: string): { sign: -1 | 0 | 1; whole: string; frac: string } {
  if (!isDecimalString(value)) {
    throw new TermsValidationError(`not a decimal: ${quote(value)}`);
  }
  const sign: -1 | 1 = value.startsWith("-") ? -1 : 1;
  let body = value.replace(/^[+-]/, "");
  if (body.startsWith(".")) body = `0${body}`;
  if (body.endsWith(".")) body = `${body}0`;
  const [wholeRaw, fracRaw = ""] = body.split(".");
  const whole = (wholeRaw ?? "0").replace(/^0+(?=\d)/, "");
  const frac = fracRaw.replace(/0+$/, "");
  if (whole === "0" && frac === "") return { sign: 0, whole: "0", frac: "" };
  return { sign, whole, frac };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TermsValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function quote(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  return `'${JSON.stringify(value)}'`;
}
