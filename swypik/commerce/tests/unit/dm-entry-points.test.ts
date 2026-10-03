import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock("@/lib/db", () => ({ dbQuery }));

import { parseDmEntry, resolveDmPeer } from "@/lib/dm/entry-points";
import { dmEntryHref, notificationHref } from "@/lib/dm/links";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const SELLER_ID = "33333333-3333-4333-8333-333333333333";
const SELLER_USER = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  dbQuery.mockReset();
});

describe("DM entry links", () => {
  it("builds one /messages/new link per entity kind", () => {
    expect(dmEntryHref({ kind: "seller", id: SELLER_ID })).toBe(`/messages/new?seller=${SELLER_ID}`);
    expect(dmEntryHref({ kind: "food_order", id: ORDER })).toBe(`/messages/new?food_order=${ORDER}`);
  });

  it("parses the first valid uuid entry and ignores junk", () => {
    expect(parseDmEntry({ seller: SELLER_ID })).toEqual({ kind: "seller", id: SELLER_ID });
    expect(parseDmEntry({ user: "not-a-uuid", order: ORDER })).toEqual({ kind: "order", id: ORDER });
    expect(parseDmEntry({ user: "1; DROP TABLE users" })).toBeNull();
    expect(parseDmEntry({})).toBeNull();
  });
});

describe("resolveDmPeer", () => {
  it("maps a seller id to the seller's USER id (the old button sent sellers.id)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ peer: SELLER_USER }] });
    const peer = await resolveDmPeer({ kind: "seller", id: SELLER_ID }, VIEWER);
    expect(peer).toBe(SELLER_USER);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("FROM sellers");
    expect(sql).toContain("user_id");
    expect(params).toEqual([SELLER_ID, VIEWER]);
  });

  it("only resolves an order for its buyer or its seller", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    expect(await resolveDmPeer({ kind: "order", id: ORDER }, VIEWER)).toBeNull();
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toContain("o.buyer_user_id = $2 OR s.user_id = $2");
  });

  it("scopes food orders to the customer or the restaurant owner", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ peer: SELLER_USER }] });
    expect(await resolveDmPeer({ kind: "food_order", id: ORDER }, VIEWER)).toBe(SELLER_USER);
    expect(dbQuery.mock.calls[0][0]).toContain("lo.customer_user_id = $2 OR s.user_id = $2");
  });

  it("never returns the viewer as their own peer", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ peer: VIEWER }] });
    expect(await resolveDmPeer({ kind: "user", id: VIEWER }, VIEWER)).toBeNull();
  });
});

describe("notification links", () => {
  it("rewrites the legacy /dm/<id> link (404) to the conversation", () => {
    expect(notificationHref(`/dm/${ORDER}`)).toBe(`/messages/${ORDER}`);
    expect(notificationHref("/account/orders/1")).toBe("/account/orders/1");
  });
  it("drops external or protocol-relative links", () => {
    expect(notificationHref("https://evil.example")).toBeUndefined();
    expect(notificationHref("//evil.example")).toBeUndefined();
    expect(notificationHref(null)).toBeUndefined();
  });
});
