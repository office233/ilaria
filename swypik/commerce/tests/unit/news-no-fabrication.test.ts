import { describe, it, expect, vi, beforeEach } from "vitest";

const inserts: string[] = [];

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (/INSERT INTO news_(articles|raw_items|article_sources)/.test(sql)) inserts.push(sql);
    if (sql.includes("FROM news_sources")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }),
  withAdvisoryLock: async <T,>(_key: string, fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/news/repository", () => ({ countArticlesPublishedToday: vi.fn(async () => 0) }));

import { generateAutonomousNewsArticle } from "@/lib/news/ai-journalist";
import { runNewsIngestionPipeline } from "@/lib/news/rss-ingester";

describe("news pipeline never fabricates articles", () => {
  beforeEach(() => {
    inserts.length = 0;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
    delete process.env.NEWS_AI_DEPLOYMENT;
  });

  it("returns null (no template article) when no AI key is configured", async () => {
    const out = await generateAutonomousNewsArticle({
      title: "Real headline from a feed",
      source: "BBC",
      summary: "Some summary",
      url: "https://bbc.co.uk/x",
      categoryHint: "business",
    });
    expect(out).toBeNull();
  });

  it("does not even fetch feeds when the AI model/key are not configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await runNewsIngestionPipeline();
    expect(res).toMatchObject({ ingested: 0, reason: "ai_not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("stays off with a deployment but no Azure endpoint/key (no other provider fallback)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GEMINI_API_KEY = "legacy";
    process.env.NEWS_AI_DEPLOYMENT = "some-model";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await generateAutonomousNewsArticle({ title: "Headline", source: "BBC", summary: "Summary", url: "https://bbc.co.uk/x" });
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("publishes nothing when every live feed is unreachable", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://res.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "test-key";
    process.env.NEWS_AI_DEPLOYMENT = "test-model";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await runNewsIngestionPipeline();
    expect(res.ingested).toBe(0);
    expect(inserts).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
