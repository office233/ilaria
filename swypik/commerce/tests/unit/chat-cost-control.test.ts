import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  identity: vi.fn(),
  orchestrate: vi.fn(),
  searchPG: vi.fn(),
  searchWithFallback: vi.fn(),
  fetchBundles: vi.fn(),
  moderateOutput: vi.fn(),
  azureConfigured: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  frozenResponse: vi.fn(),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: h.rateLimit,
  getClientIP: () => "203.0.113.10",
}));
vi.mock("@/lib/chat/request-identity", () => ({
  getChatRequestIdentityKey: h.identity,
}));
vi.mock("@/lib/ai/azure", () => ({
  isAzureChatConfigured: h.azureConfigured,
}));
vi.mock("@/lib/ai/orchestrator", () => ({
  orchestrate: h.orchestrate,
}));
vi.mock("@/lib/ai/moderation", () => ({
  moderateOutput: h.moderateOutput,
}));
vi.mock("@/lib/chat/category-detect", () => ({
  detectCategory: () => null,
  looksLikeShopping: () => false,
}));
vi.mock("@/lib/chat/search-pg", () => ({
  searchPG: h.searchPG,
  searchWithFallback: h.searchWithFallback,
  fetchBundles: h.fetchBundles,
  buildBundleSuggestionText: () => "",
  uniqueProducts: (items: unknown[]) => items,
}));
vi.mock("@/lib/sales/bundle-engine", () => ({
  inferBundleQueries: () => [],
  buildSalesSuggestion: () => "",
}));

import { POST } from "@/app/api/chat/route";
import { ChatPostSchema } from "@/lib/validation/schemas";

beforeEach(() => {
  h.rateLimit.mockReset().mockResolvedValue({ success: true, remaining: 10 });
  h.identity.mockReset().mockResolvedValue("anon:test");
  h.orchestrate.mockReset().mockResolvedValue({
    intent: "general_chat",
    reply: "Salut",
  });
  h.searchPG.mockReset().mockResolvedValue([]);
  h.searchWithFallback.mockReset().mockResolvedValue({ products: [], replyPrefix: "" });
  h.fetchBundles.mockReset().mockResolvedValue([]);
  h.moderateOutput.mockReset().mockResolvedValue({ safe: true, reason: "ok" });
  h.azureConfigured.mockReset().mockReturnValue(true);
});

function req(body: unknown): Request {
  return new Request("https://swypik.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ChatPostSchema bounds", () => {
  it("strips unknown product-context fields and bounds chat history", () => {
    const parsed = ChatPostSchema.parse({
      message: "  salut  ",
      chatHistory: [{ role: "user", content: "x" }],
      productContext: [{ id: "1", title: "Produs", giant: "secret" }],
      shoppingSession: { budget: 100, garbage: "drop" },
    });
    expect(parsed.message).toBe("salut");
    expect(parsed.productContext?.[0]).toEqual({ id: "1", title: "Produs" });
    expect(parsed.shoppingSession).toEqual({ budget: 100 });

    expect(
      ChatPostSchema.safeParse({
        message: "x",
        chatHistory: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })),
      }).success,
    ).toBe(false);
  });
});

describe("POST /api/chat cost controls", () => {
  it("does not consume AI quota for direct catalog search", async () => {
    const res = await POST(req({ message: "telefon", directCjQuery: "telefon" }));
    expect(res.status).toBe(200);
    expect(h.orchestrate).not.toHaveBeenCalled();
    expect(h.rateLimit).toHaveBeenCalledTimes(2); // IP + first-party identity
  });

  it("applies minute + daily AI quotas before orchestration", async () => {
    const res = await POST(req({ message: "ce imi recomanzi?" }));
    expect(res.status).toBe(200);
    expect(h.rateLimit).toHaveBeenCalledTimes(4);
    expect(h.orchestrate).toHaveBeenCalledTimes(1);
  });

  it("returns 429 before Azure when AI budget is exhausted", async () => {
    h.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 10 }) // IP
      .mockResolvedValueOnce({ success: true, remaining: 10 }) // identity
      .mockResolvedValueOnce({ success: false, remaining: 0 }) // AI minute
      .mockResolvedValueOnce({ success: true, remaining: 10 }); // AI daily

    const res = await POST(req({ message: "spune-mi o poveste lunga" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "ai_rate_limited" });
    expect(h.orchestrate).not.toHaveBeenCalled();
  });
});
