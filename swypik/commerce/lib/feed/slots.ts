/**
 * Sloturile cardurilor de modul în feed-ul video (configurabile, nu în cod):
 *   DB `feed_slot_config` (migrarea 20260926_0130) > env `FEED_SLOT_<KIND>`
 *   ("every,first,maxPerPage" sau "off") > valorile implicite.
 *
 * Semantică (poziții globale, 0 = primul item din feed): un card de tipul K
 * e „datorat” pe pozițiile p ≥ first cu (p − first) % every = 0.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { FEED_CARD_KINDS, type FeedCardKind } from "./types";

export type SlotRule = {
  kind: FeedCardKind;
  every: number;
  first: number;
  maxPerPage: number;
  enabled: boolean;
  /** Mai mic = câștigă când două tipuri cad pe aceeași poziție. */
  priority: number;
};

export const DEFAULT_SLOT_RULES: readonly SlotRule[] = [
  { kind: "live", every: 12, first: 2, maxPerPage: 1, enabled: true, priority: 10 },
  { kind: "product", every: 7, first: 4, maxPerPage: 3, enabled: true, priority: 20 },
  { kind: "movie", every: 13, first: 9, maxPerPage: 1, enabled: true, priority: 30 },
  { kind: "music", every: 17, first: 11, maxPerPage: 1, enabled: true, priority: 40 },
  { kind: "stay", every: 19, first: 15, maxPerPage: 1, enabled: true, priority: 50 },
  { kind: "food", every: 23, first: 20, maxPerPage: 1, enabled: true, priority: 60 },
  { kind: "news", every: 10, first: 7, maxPerPage: 1, enabled: true, priority: 70 },
];

const CACHE_TTL_MS = 60_000;
let cache: { rules: SlotRule[]; at: number } | null = null;

type SlotRow = {
  kind: string;
  every_n: number;
  first_slot: number;
  max_per_page: number;
  enabled: boolean;
  priority: number;
};

function isKind(k: string): k is FeedCardKind {
  return (FEED_CARD_KINDS as readonly string[]).includes(k);
}

function sane(rule: SlotRule): SlotRule {
  return {
    ...rule,
    every: Math.max(2, Math.trunc(rule.every) || 2),
    first: Math.max(0, Math.trunc(rule.first) || 0),
    maxPerPage: Math.max(0, Math.trunc(rule.maxPerPage) || 0),
  };
}

/** Pură: defaults ← DB ← env. */
export function mergeSlotRules(rows: readonly SlotRow[], env: NodeJS.ProcessEnv = process.env): SlotRule[] {
  const byKind = new Map<FeedCardKind, SlotRule>(DEFAULT_SLOT_RULES.map((r) => [r.kind, { ...r }]));
  for (const row of rows) {
    if (!isKind(row.kind)) continue;
    byKind.set(row.kind, {
      kind: row.kind,
      every: Number(row.every_n),
      first: Number(row.first_slot),
      maxPerPage: Number(row.max_per_page),
      enabled: Boolean(row.enabled),
      priority: Number(row.priority),
    });
  }
  for (const kind of FEED_CARD_KINDS) {
    const raw = env[`FEED_SLOT_${kind.toUpperCase()}`]?.trim();
    if (!raw) continue;
    const current = byKind.get(kind);
    if (!current) continue;
    if (raw === "off") {
      current.enabled = false;
      continue;
    }
    const [every, first, max] = raw.split(",").map((s) => Number(s.trim()));
    if (Number.isFinite(every)) current.every = every;
    if (Number.isFinite(first)) current.first = first;
    if (Number.isFinite(max)) current.maxPerPage = max;
    current.enabled = true;
  }
  return Array.from(byKind.values()).map(sane).sort((a, b) => a.priority - b.priority);
}

export async function loadSlotRules(): Promise<SlotRule[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rules;
  let rows: SlotRow[] = [];
  try {
    const res = await dbQuery<SlotRow>(
      `SELECT kind, every_n, first_slot, max_per_page, enabled, priority FROM feed_slot_config`,
    );
    rows = res.rows;
  } catch (err) {
    logger.warn({ err }, "[feed/slots] feed_slot_config unavailable, using env/defaults");
  }
  const rules = mergeSlotRules(rows);
  cache = { rules, at: Date.now() };
  return rules;
}

/** Doar pentru teste. */
export function _resetSlotCache(): void {
  cache = null;
}
