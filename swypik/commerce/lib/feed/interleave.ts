/**
 * Intercalarea cardurilor de modul în fluxul video — pur, determinist, fără
 * stare între pagini: tot ce contează e poziția globală `p` (cursorul o duce
 * mai departe), deci aceeași poziție primește mereu același tip de card și
 * același card din pool (pool[n], n = a câta apariție a tipului).
 *
 * Reguli: un card niciodată pe poziția 0, niciodată imediat după o poziție
 * „datorată” altui card (cardurile nu stau lipite), maxim `maxPerPage` per tip
 * într-o pagină; un pool gol / epuizat lasă poziția unui clip.
 */
import type { SlotRule } from "./slots";
import type { FeedCard, FeedCardItem, FeedCardKind, FeedItem, FeedVideoItem } from "./types";

export function isDue(rule: SlotRule, p: number): boolean {
  return rule.enabled && rule.maxPerPage > 0 && p >= Math.max(1, rule.first) && (p - rule.first) % rule.every === 0;
}

/** Regula câștigătoare pe poziția p (prioritate), sau null. */
export function dueRule(rules: readonly SlotRule[], p: number): SlotRule | null {
  if (p < 1) return null;
  for (const r of rules) if (isDue(r, p)) return r;
  return null;
}

/** Indexul în pool al cardului de tipul regulii pe poziția p. */
export function occurrenceIndex(rule: SlotRule, p: number): number {
  return Math.floor((p - rule.first) / rule.every);
}

/**
 * Câte carduri din fiecare tip ar putea fi cerute pe intervalul [start, start+span):
 * `limit` pentru producătorul modulului (indexul maxim + 1).
 */
export function cardDemand(rules: readonly SlotRule[], start: number, span: number): Map<FeedCardKind, number> {
  const demand = new Map<FeedCardKind, number>();
  for (let p = start; p < start + span; p++) {
    const r = dueRule(rules, p);
    if (!r) continue;
    const need = occurrenceIndex(r, p) + 1;
    demand.set(r.kind, Math.max(demand.get(r.kind) ?? 0, need));
  }
  return demand;
}

export type InterleaveInput = {
  videos: readonly FeedVideoItem[];
  rules: readonly SlotRule[];
  pools: ReadonlyMap<FeedCardKind, readonly FeedCard[]>;
  /** Poziția globală a primului item din pagină. */
  startPos: number;
};

export type InterleaveResult = { items: FeedItem[]; nextPos: number };

export function interleave({ videos, rules, pools, startPos }: InterleaveInput): InterleaveResult {
  const items: FeedItem[] = [];
  const perPage = new Map<FeedCardKind, number>();
  const usedCards = new Set<string>();
  let p = startPos;
  let vi = 0;

  while (vi < videos.length) {
    const rule = dueRule(rules, p);
    const blockedByNeighbour = rule !== null && dueRule(rules, p - 1) !== null;
    let card: FeedCard | undefined;
    if (rule && !blockedByNeighbour && (perPage.get(rule.kind) ?? 0) < rule.maxPerPage) {
      card = pools.get(rule.kind)?.[occurrenceIndex(rule, p)];
      if (card && usedCards.has(`${card.kind}:${card.id}`)) card = undefined;
    }
    if (card) {
      const key = `${card.kind}:${card.id}`;
      usedCards.add(key);
      perPage.set(card.kind, (perPage.get(card.kind) ?? 0) + 1);
      const item: FeedCardItem = { kind: card.kind, key, card };
      items.push(item);
    } else {
      items.push(videos[vi]);
      vi++;
    }
    p++;
  }
  return { items, nextPos: p };
}
