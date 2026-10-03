import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));

import { cardDemand, dueRule, interleave } from "@/lib/feed/interleave";
import { DEFAULT_SLOT_RULES, mergeSlotRules, type SlotRule } from "@/lib/feed/slots";
import type { FeedCard, FeedCardKind, FeedVideo, FeedVideoItem } from "@/lib/feed/types";

function videos(n: number, prefix = "v"): FeedVideoItem[] {
  return Array.from({ length: n }, (_, i) => ({ kind: "video", key: `video:${prefix}${i}`, video: { id: `${prefix}${i}` } as FeedVideo }));
}

function cards(kind: FeedCardKind, n: number): FeedCard[] {
  return Array.from({ length: n }, (_, i) => ({
    kind,
    id: `${kind}${i}`,
    title: `${kind} ${i}`,
    subtitle: null,
    image: null,
    href: `/${kind}/${i}`,
    price: null,
    summary: null,
    attribution: null,
    sourceUrl: null,
    viewerCount: null,
    isFree: null,
  }));
}

const rule = (kind: FeedCardKind, every: number, first: number, maxPerPage = 5, priority = 1): SlotRule => ({
  kind,
  every,
  first,
  maxPerPage,
  enabled: true,
  priority,
});

describe("slot config", () => {
  it("DB suprascrie defaults, env suprascrie DB, `off` dezactivează, valori absurde sunt corectate", () => {
    const rules = mergeSlotRules(
      [{ kind: "product", every_n: 5, first_slot: 3, max_per_page: 2, enabled: true, priority: 1 }, { kind: "bogus", every_n: 1, first_slot: 0, max_per_page: 1, enabled: true, priority: 0 }],
      { FEED_SLOT_NEWS: "off", FEED_SLOT_MOVIE: "4,2,1", FEED_SLOT_FOOD: "0,-3,1" } as unknown as NodeJS.ProcessEnv,
    );
    const by = new Map(rules.map((r) => [r.kind, r]));
    expect(by.get("product")).toMatchObject({ every: 5, first: 3, maxPerPage: 2 });
    expect(by.get("news")?.enabled).toBe(false);
    expect(by.get("movie")).toMatchObject({ every: 4, first: 2, enabled: true });
    expect(by.get("food")).toMatchObject({ every: 2, first: 0 });
    expect(rules[0].kind).toBe("product");
    expect(rules).toHaveLength(DEFAULT_SLOT_RULES.length);
  });
});

describe("interleave", () => {
  it("pune cardurile pe pozițiile datorate și păstrează toate clipurile în ordine", () => {
    const rules = [rule("product", 4, 2)];
    const { items, nextPos } = interleave({ videos: videos(6), rules, pools: new Map<FeedCardKind, FeedCard[]>([["product", cards("product", 5)]]), startPos: 0 });
    expect(items.map((i) => i.kind)).toEqual(["video", "video", "product", "video", "video", "video", "product", "video"]);
    expect(items.filter((i) => i.kind === "video").map((i) => i.key)).toEqual(videos(6).map((v) => v.key));
    expect(nextPos).toBe(8);
  });

  it("niciun card pe poziția 0 și niciodată două carduri lipite", () => {
    const rules = [rule("live", 3, 0, 5, 1), rule("news", 3, 1, 5, 2)];
    const { items } = interleave({
      videos: videos(10),
      rules,
      pools: new Map<FeedCardKind, FeedCard[]>([
        ["live", cards("live", 10)],
        ["news", cards("news", 10)],
      ]),
      startPos: 0,
    });
    expect(items[0].kind).toBe("video");
    for (let i = 1; i < items.length; i++) {
      expect(items[i].kind !== "video" && items[i - 1].kind !== "video").toBe(false);
    }
  });

  it("respectă maxPerPage și lasă clipul când pool-ul e gol", () => {
    const rules = [rule("product", 2, 1, 1)];
    const { items } = interleave({ videos: videos(6), rules, pools: new Map<FeedCardKind, FeedCard[]>([["product", cards("product", 10)]]), startPos: 0 });
    expect(items.filter((i) => i.kind === "product")).toHaveLength(1);
    const empty = interleave({ videos: videos(4), rules, pools: new Map(), startPos: 0 });
    expect(empty.items.every((i) => i.kind === "video")).toBe(true);
  });

  it("paginile consecutive continuă sloturile fără să repete carduri", () => {
    const rules = [rule("product", 5, 3, 5)];
    const pools = new Map<FeedCardKind, FeedCard[]>([["product", cards("product", 10)]]);
    const p1 = interleave({ videos: videos(8, "a"), rules, pools, startPos: 0 });
    const p2 = interleave({ videos: videos(8, "b"), rules, pools, startPos: p1.nextPos });
    const all = [...p1.items, ...p2.items];
    const cardKeys = all.filter((i) => i.kind === "product").map((i) => i.key);
    expect(new Set(cardKeys).size).toBe(cardKeys.length);
    all.forEach((item, p) => {
      if (item.kind === "product") expect(dueRule(rules, p)?.kind).toBe("product");
    });
    expect(cardKeys[0]).toBe("product:product0");
    expect(cardKeys[1]).toBe("product:product1");
  });

  it("cardDemand cere doar tipurile datorate în interval", () => {
    const rules = [rule("product", 7, 4), rule("food", 50, 40)];
    expect(Array.from(cardDemand(rules, 0, 12).entries())).toEqual([["product", 2]]);
    expect(cardDemand(rules, 38, 5).get("food")).toBe(1);
  });
});
