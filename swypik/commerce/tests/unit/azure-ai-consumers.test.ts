import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/** Consumatorii Azure AI: moderare text/imagine (mapare + degradare 429), chat shop, jurnalist știri, transcriere. */

vi.mock("@/lib/logger", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...l, child: () => l } };
});
vi.mock("@/lib/db/product-queries", () => ({
  getCategories: vi.fn(async () => [{ name: "Electronice", nameEn: "Consumer Electronics", count: 120 }]),
}));

import { moderate } from "@/lib/ai/moderate";
import { moderateOutput } from "@/lib/ai/moderation";
import { moderateUserText } from "@/lib/moderation/ai-text";
import { moderateImage } from "@/lib/moderation/ai-image";
import { orchestrate } from "@/lib/ai/orchestrator";
import { generateAutonomousNewsArticle } from "@/lib/news/ai-journalist";
import { transcribe } from "@/lib/ai/transcribe";

const OPENAI = {
  AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com",
  AZURE_OPENAI_API_KEY: "k",
  AZURE_OPENAI_CHAT_DEPLOYMENT: "gpt-5.4-mini",
};
const SAFETY = { AZURE_CONTENT_SAFETY_ENDPOINT: "https://cs.example", AZURE_CONTENT_SAFETY_KEY: "k" };
const ALL_KEYS = [...Object.keys(OPENAI), ...Object.keys(SAFETY), "AZURE_OPENAI_WHISPER_DEPLOYMENT"];

const fetchMock = vi.fn();
const safety = (sev: Partial<Record<"Hate" | "SelfHarm" | "Sexual" | "Violence", number>>) =>
  new Response(JSON.stringify({ categoriesAnalysis: Object.entries(sev).map(([category, severity]) => ({ category, severity })) }));
const rateLimited = () => new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } });
const completion = (obj: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: "stop" }], usage: {} }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("moderate (video text at publish)", () => {
  it("not configured → not flagged, no network", async () => {
    expect(await moderate("orice")).toMatchObject({ flagged: false, decision: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps review severities to flagged reasons", async () => {
    Object.assign(process.env, SAFETY);
    fetchMock.mockResolvedValueOnce(safety({ Violence: 4 }));
    expect(await moderate("text")).toMatchObject({ flagged: true, decision: "review", reasons: ["violence:4"] });
  });

  it("F0 rate limit after retries → flagged 'moderation_unavailable' (pending review)", async () => {
    Object.assign(process.env, SAFETY);
    fetchMock.mockImplementation(async () => rateLimited());
    expect(await moderate("text")).toMatchObject({ flagged: true, decision: "unavailable", reasons: ["moderation_unavailable"] });
  });
});

describe("moderateOutput (shop chat)", () => {
  it("blocks at review threshold and fails open when unavailable", async () => {
    Object.assign(process.env, SAFETY);
    fetchMock.mockResolvedValueOnce(safety({ Sexual: 6 }));
    expect(await moderateOutput("x")).toMatchObject({ safe: false });
    fetchMock.mockImplementation(async () => rateLimited());
    expect(await moderateOutput("x")).toEqual({ safe: true, reason: "moderation-unavailable" });
  });
});

describe("moderateUserText (comments / bios / posts)", () => {
  beforeEach(() => Object.assign(process.env, SAFETY));

  it("review → comment hidden, bio rejected", async () => {
    fetchMock.mockImplementation(async () => safety({ Hate: 4 }));
    expect(await moderateUserText("mesaj", "comment")).toMatchObject({ action: "hide", ai: true, degraded: false });
    expect(await moderateUserText("bio", "bio")).toMatchObject({ action: "reject", ai: true });
  });

  it("block → reject everywhere with the blocked label", async () => {
    fetchMock.mockImplementation(async () => safety({ SelfHarm: 6 }));
    expect(await moderateUserText("x", "comment")).toMatchObject({ action: "reject", label: "blocked", reasons: ["selfharm:6"] });
  });

  it("unavailable → comment held for review (no strike), bio allowed", async () => {
    fetchMock.mockImplementation(async () => rateLimited());
    expect(await moderateUserText("x", "comment")).toMatchObject({ action: "hide", degraded: true });
    expect(await moderateUserText("x", "bio")).toMatchObject({ action: "allow", degraded: true });
  });

  it("search never calls the AI; clean text stays allowed", async () => {
    expect(await moderateUserText("telefon", "search")).toMatchObject({ action: "allow", ai: false });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(safety({}));
    expect(await moderateUserText("salut", "post")).toMatchObject({ action: "allow" });
  });
});

describe("moderateImage", () => {
  const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();

  it("maps image severities with image thresholds (review 2 / block 4)", async () => {
    Object.assign(process.env, SAFETY);
    const img = await png();
    fetchMock.mockResolvedValueOnce(safety({ Sexual: 2 }));
    expect(await moderateImage(img, "t")).toEqual({ decision: "review", reasons: ["sexual:2"] });
    fetchMock.mockResolvedValueOnce(safety({ Violence: 4 }));
    expect((await moderateImage(img, "t")).decision).toBe("block");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(typeof body.image.content).toBe("string");
  });

  it("unavailable when rate limited; allow when not configured", async () => {
    const img = await png();
    expect(await moderateImage(img, "t")).toEqual({ decision: "not_configured", reasons: [] });
    Object.assign(process.env, SAFETY);
    fetchMock.mockImplementation(async () => rateLimited());
    expect(await moderateImage(img, "t")).toEqual({ decision: "unavailable", reasons: ["moderation_unavailable"] });
  });
});

describe("shop chat orchestrator", () => {
  it("falls back to the deterministic router when Azure is not configured", async () => {
    const out = await orchestrate("caut rochie sub 100 lei");
    expect(out.intent).toBe("search_product");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the structured Azure answer when configured", async () => {
    Object.assign(process.env, OPENAI);
    fetchMock.mockResolvedValueOnce(
      completion({ intent: "search_product", reply: "Uite ce am găsit", searchQuery: "wireless earbuds", category: null, bundleQueries: ["case"], productId: null, productTitle: null, maxPrice: 200, sort: "price_asc", shouldAskFollowUp: true }),
    );
    const out = await orchestrate("vreau casti");
    expect(out).toMatchObject({ intent: "search_product", reply: "Uite ce am găsit", searchQuery: "wireless earbuds", maxPrice: 200, sort: "price_asc", bundleQueries: ["case"] });
    expect(out.category).toBeUndefined();
  });

  it("falls back after a 429 storm", async () => {
    Object.assign(process.env, OPENAI);
    fetchMock.mockImplementation(async () => rateLimited());
    const out = await orchestrate("salut");
    expect(out.intent).toBe("general_chat");
  });
});

describe("news journalist", () => {
  const topic = { title: "Banca centrală a redus dobânda", source: "Agenția X", summary: "Banca a anunțat marți o reducere a dobânzii de politică monetară.", url: "https://agentia.example/a", categoryHint: "business" };
  const article = {
    title: "Dobânda de politică monetară, redusă de banca centrală",
    slug: "dobanda-redusa-banca-centrala",
    summary_tldr: "⚡ Ce s-a întâmplat: banca centrală a redus dobânda.\n📊 Date cheie: decizie anunțată marți.\n🔮 Impactul: credite mai ieftine.",
    content_markdown: `${"Banca centrală a decis o relaxare a politicii monetare, conform anunțului oficial. ".repeat(3)}\n\n## Context\nDecizia vine după luni de inflație în scădere.\n\n## Analiză\nPiețele au reacționat calm.\n\n## Pașii următori\nUrmătoarea ședință va clarifica direcția.`,
    category_slug: "business",
    tags: ["dobânzi"],
    image_search_keywords: "central bank rates",
    reading_time_minutes: 3,
    is_breaking: false,
  };

  it("returns a validated article from the structured answer", async () => {
    Object.assign(process.env, OPENAI);
    fetchMock.mockResolvedValueOnce(completion(article));
    const out = await generateAutonomousNewsArticle(topic);
    expect(out).toMatchObject({ slug: "dobanda-redusa-banca-centrala", category_slug: "business" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("<untrusted-summary>");
    expect(body.response_format.json_schema.name).toBe("news_article");
  });

  it("keeps the anti-fabrication guard: an injected URL is rejected → null", async () => {
    Object.assign(process.env, OPENAI);
    fetchMock.mockResolvedValueOnce(completion({ ...article, content_markdown: `${article.content_markdown}\nVezi https://evil.example` }));
    expect(await generateAutonomousNewsArticle(topic)).toBeNull();
  });

  it("returns null when Azure keeps answering 429", async () => {
    Object.assign(process.env, OPENAI);
    fetchMock.mockImplementation(async () => rateLimited());
    expect(await generateAutonomousNewsArticle(topic)).toBeNull();
  });
});

describe("transcribe wrapper", () => {
  it("not configured → empty result, no network", async () => {
    expect(await transcribe(Buffer.from([1]), "ro")).toEqual({ text: "", segments: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Whisper segments when configured", async () => {
    Object.assign(process.env, OPENAI, { AZURE_OPENAI_WHISPER_DEPLOYMENT: "whisper" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ text: "Salut", segments: [{ start: 0, end: 1, text: "Salut" }] })));
    expect(await transcribe(Buffer.from([1]), "ro")).toEqual({ text: "Salut", segments: [{ start: 0, end: 1, text: "Salut" }] });
  });
});
