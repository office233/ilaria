import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

import { decodeHTMLEntities, getDailyTriviaQuestions, triviaLanguage } from "@/lib/gaming/opentdb";
import roBank from "@/lib/gaming/trivia-bank/ro.json";

describe("trivia — decodare entități", () => {
  it("decodează entitățile numerice și cele cu nume (inclusiv &rsquo; &uuml;)", () => {
    expect(decodeHTMLEntities("Nintendo&rsquo;s &quot;Mario&quot; &amp; M&uuml;ller &#039;x&#039; &#x263A; &hellip;")).toBe(
      "Nintendo’s \"Mario\" & Müller 'x' ☺ …",
    );
  });
  it("lasă neatinse entitățile necunoscute", () => {
    expect(decodeHTMLEntities("&foo; &#0;")).toBe("&foo; &#0;");
  });
});

describe("trivia — limbă", () => {
  it("RO are bancă proprie, restul limbilor primesc engleză", () => {
    expect(triviaLanguage("ro")).toBe("ro");
    for (const l of ["en", "de", "fr", "es", "pt", "it", null]) expect(triviaLanguage(l)).toBe("en");
  });
  it("runda RO: 5 întrebări din banca RO, fără fetch extern, răspunsul corect printre opțiuni", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const qs = await getDailyTriviaQuestions("ro");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(qs).toHaveLength(5);
    const texts = new Set((roBank as Array<{ question: string }>).map((q) => q.question));
    for (const q of qs) {
      expect(texts.has(q.question)).toBe(true);
      expect(q.options).toContain(q.correctAnswer);
      expect(new Set(q.options).size).toBe(4);
    }
    fetchSpy.mockRestore();
  });
});
