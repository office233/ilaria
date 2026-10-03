import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// In-memory news tables: enough to exercise the claim / slug / publish SQL.
const db = {
  raw: new Map<string, { id: string; processed: boolean; attempts: number }>(),
  articles: new Map<string, { id: string; status: string; model: string; cover: string }>(),
  sources: [] as unknown[][],
};
let seq = 0;

vi.mock("@/lib/db", () => ({
  withAdvisoryLock: async <T,>(_k: string, fn: () => Promise<T>) => fn(),
  dbQuery: vi.fn(async (sql: string, p: unknown[] = []) => {
    const rows = (r: unknown[] = []) => ({ rows: r, rowCount: r.length });
    if (sql.includes("FROM news_sources s")) {
      return rows([
        { id: "src-bbc", name: "BBC Business", feed_url: "https://feeds.example/bbc.xml", category_slug: "business", last_fetched_at: null },
        { id: "src-atom", name: "Atom Science", feed_url: "https://feeds.example/atom.xml", category_slug: "science", last_fetched_at: null },
      ]);
    }
    if (sql.includes("INSERT INTO news_raw_items")) {
      const url = String(p[0]);
      const maxAttempts = Number(p[7]);
      const cur = db.raw.get(url);
      if (!cur) {
        const id = `raw-${++seq}`;
        db.raw.set(url, { id, processed: false, attempts: 1 });
        return rows([{ id }]);
      }
      if (!cur.processed && cur.attempts < maxAttempts) {
        cur.attempts++;
        return rows([{ id: cur.id }]);
      }
      return rows();
    }
    if (sql.includes("UPDATE news_raw_items SET is_processed")) {
      for (const v of db.raw.values()) if (v.id === p[0]) v.processed = true;
      return rows();
    }
    if (sql.includes("FROM news_categories WHERE slug")) return rows([{ id: `cat-${p[0]}` }]);
    if (sql.includes("INSERT INTO news_articles")) {
      const slug = String(p[0]);
      if (db.articles.has(slug)) return rows();
      const id = `art-${++seq}`;
      db.articles.set(slug, { id, status: String(p[8]), model: String(p[7]), cover: String(p[5]) });
      return rows([{ id }]);
    }
    if (sql.includes("INSERT INTO news_article_sources")) {
      db.sources.push(p);
      return rows();
    }
    if (sql.includes("COUNT(*)::text as count FROM news_articles")) return rows([{ count: "0" }]);
    return rows();
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const generate = vi.fn();
vi.mock("@/lib/news/ai-journalist", () => ({ generateAutonomousNewsArticle: (t: unknown) => generate(t) }));

import { runNewsIngestionPipeline } from "@/lib/news/rss-ingester";

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>Markets rally</title><link>https://bbc.example/a</link><description><![CDATA[<p>Stocks up.</p>]]></description>
    <media:content url="https://img.example/a.jpg" medium="image"/></item>
  <item><title>Markets rally (dup link)</title><link>https://bbc.example/a</link><description>dup</description></item>
  <item><title>Rates held</title><link>https://bbc.example/b</link><description>Central bank holds.</description></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Comet seen</title>
  <link rel="alternate" href="https://atom.example/comet"/><summary>A comet.</summary><updated>2026-09-25T10:00:00Z</updated></entry></feed>`;

function article(slug: string) {
  return {
    title: `Title ${slug}`, slug, summary_tldr: "summary text long enough", content_markdown: "x".repeat(250),
    category_slug: "business", tags: [], image_search_keywords: "", reading_time_minutes: 3,
    is_breaking: false, fact_check_score: 0, fact_check_notes: "",
  };
}

beforeEach(() => {
  db.raw.clear();
  db.articles.clear();
  db.sources = [];
  generate.mockReset();
  generate.mockImplementation(async (t: { url: string }) => article(`story-${t.url.slice(-1)}`));
  process.env.AZURE_OPENAI_ENDPOINT = "https://res.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "k";
  process.env.NEWS_AI_DEPLOYMENT = "model-from-env";
  delete process.env.NEWS_PUBLISH_MODE;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.includes("atom") ? ATOM : RSS, { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.NEWS_AI_DEPLOYMENT;
});

describe("news ingest dedupe", () => {
  it("ingests each real feed item once (RSS + Atom), with source link and env model", async () => {
    const res = await runNewsIngestionPipeline();
    expect(res.ingested).toBe(3); // a, b, comet — the duplicate link inside the feed is dropped by the parser
    expect(generate).toHaveBeenCalledTimes(3);
    expect(db.sources.map((s) => s[2]).sort()).toEqual(["https://atom.example/comet", "https://bbc.example/a", "https://bbc.example/b"]);
    expect(db.sources.every((s) => typeof s[1] === "string")).toBe(true); // source_id written
    const a = db.articles.get("story-a");
    expect(a).toMatchObject({ status: "published", model: "azure:model-from-env", cover: "https://img.example/a.jpg" });
  });

  it("a second run over the same feeds generates nothing (duplicates)", async () => {
    await runNewsIngestionPipeline();
    generate.mockClear();
    const res = await runNewsIngestionPipeline();
    expect(res.ingested).toBe(0);
    expect(res.duplicates).toBe(3);
    expect(generate).not.toHaveBeenCalled();
  });

  it("a rejected summary is retried on a later run, but only up to the attempt limit", async () => {
    process.env.NEWS_MAX_ATTEMPTS_PER_ITEM = "2";
    generate.mockResolvedValue(null);
    const first = await runNewsIngestionPipeline();
    expect(first).toMatchObject({ ingested: 0, errors: 3 });
    await runNewsIngestionPipeline(); // attempt 2
    generate.mockClear();
    await runNewsIngestionPipeline(); // exhausted → not generated again
    expect(generate).not.toHaveBeenCalled();
    delete process.env.NEWS_MAX_ATTEMPTS_PER_ITEM;
  });

  it("never overwrites an existing slug: the clash gets a suffix", async () => {
    generate.mockImplementation(async () => article("same-slug"));
    const res = await runNewsIngestionPipeline("business");
    expect(res.ingested).toBe(2);
    const slugs = Array.from(db.articles.keys());
    expect(slugs[0]).toBe("same-slug");
    expect(slugs[1]).toMatch(/^same-slug-[0-9a-f]{6}$/);
  });

  it("review mode stores drafts instead of publishing", async () => {
    process.env.NEWS_PUBLISH_MODE = "review";
    const res = await runNewsIngestionPipeline("science");
    expect(res).toMatchObject({ ingested: 1, status: "draft" });
    expect(Array.from(db.articles.values())[0].status).toBe("draft");
  });
});
