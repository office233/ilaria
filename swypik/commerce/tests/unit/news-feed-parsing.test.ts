import { describe, it, expect } from "vitest";
import { parseFeed, decodeEntities, isHttpUrl } from "@/lib/news/rss-parser";
import { toNewsFeedItem } from "@/lib/news/feed-items";
import { plainSummary, sourceLabel } from "@/lib/news/text";
import { parseCategoryFilter } from "@/lib/news/categories";
import type { NewsArticleListItem } from "@/lib/news/repository";

const opts = { category: "tech-ai" as const, source: "Example", sourceId: "src-1", limit: 5 };

describe("rss-parser", () => {
  it("parses RSS items with CDATA, entities, images and dates", () => {
    const xml = `<rss><channel><item><title><![CDATA[AI &amp; chips]]></title><link>https://ex.com/1</link>
      <description><![CDATA[<img src="https://img.ex.com/1.png"> Hello &quot;world&quot;]]></description>
      <pubDate>Thu, 25 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const [t] = parseFeed(xml, opts);
    expect(t).toMatchObject({ title: "AI & chips", url: "https://ex.com/1", summary: 'Hello "world"', imageUrl: "https://img.ex.com/1.png", sourceId: "src-1" });
    expect(t.publishedAt).toBe("2026-09-25T10:00:00.000Z");
  });

  it("parses Atom entries (link href)", () => {
    const xml = `<feed><entry><title>Atom one</title><link rel="alternate" href="https://ex.com/a"/><summary>Sum</summary></entry></feed>`;
    expect(parseFeed(xml, opts)).toEqual([expect.objectContaining({ title: "Atom one", url: "https://ex.com/a", summary: "Sum" })]);
  });

  it("drops items without a title or a http(s) link, dedupes links, respects the limit", () => {
    const xml = `<rss>
      <item><title></title><link>https://ex.com/x</link></item>
      <item><title>Bad link</title><link>javascript:alert(1)</link></item>
      <item><title>One</title><link>https://ex.com/1</link></item>
      <item><title>One again</title><link>https://ex.com/1</link></item>
      <item><title>Two</title><link>https://ex.com/2</link></item>
      <item><title>Three</title><link>https://ex.com/3</link></item></rss>`;
    expect(parseFeed(xml, { ...opts, limit: 2 }).map((t) => t.url)).toEqual(["https://ex.com/1", "https://ex.com/2"]);
  });

  it("only accepts https images (no mixed content)", () => {
    const xml = `<rss><item><title>T</title><link>https://ex.com/1</link><enclosure url="http://img.ex.com/a.jpg" type="image/jpeg"/></item></rss>`;
    expect(parseFeed(xml, opts)[0].imageUrl).toBeNull();
  });

  it("helpers", () => {
    expect(decodeEntities("&#8217;&#x41;&amp;")).toBe("’A&");
    expect(isHttpUrl("ftp://x")).toBe(false);
    expect(isHttpUrl("http://x.com", true)).toBe(false);
    expect(parseCategoryFilter("gaming")).toBe("gaming");
    expect(parseCategoryFilter("crypto")).toBeNull();
    expect(parseCategoryFilter("all")).toBeNull();
  });
});

describe("news feed cards", () => {
  const row: NewsArticleListItem = {
    id: "a1", slug: "story", title: "Story", summary_tldr: "⚡ Ce: one\n📊 Date: two",
    cover_image_url: "", reading_time_minutes: 3, view_count: 0, published_at: "2026-09-25T10:00:00Z",
    category_name: "Business", category_slug: "business", source_name: null, source_url: "https://www.bbc.co.uk/news/1",
  };

  it("maps to {kind:'news'} with attribution + link", () => {
    expect(toNewsFeedItem(row)).toEqual({
      kind: "news", id: "a1", title: "Story", summary: "Ce: one Date: two", image: null, href: "/news/story",
      category: "business", categoryName: "Business", sourceName: "bbc.co.uk", sourceUrl: "https://www.bbc.co.uk/news/1",
      publishedAt: "2026-09-25T10:00:00.000Z",
    });
  });

  it("never emits a card without a source link", () => {
    expect(toNewsFeedItem({ ...row, source_url: "" })).toBeNull();
  });

  it("text helpers", () => {
    expect(plainSummary("a".repeat(300), 10)).toHaveLength(10);
    expect(sourceLabel("BBC", "https://bbc.co.uk")).toBe("BBC");
    expect(sourceLabel(null, "not a url")).toBe("not a url");
  });
});
