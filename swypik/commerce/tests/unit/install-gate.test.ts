import { describe, it, expect } from "vitest";
import {
  INSTALL_REPROMPT_MS,
  STORAGE,
  countPageView,
  countVisit,
  readDismissedAt,
  shouldOfferInstall,
} from "@/lib/pwa/install-gate";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

const base = { consentDecided: true, visits: 1, sessionPageViews: 1, dismissedAt: null, now: 1_000_000_000_000 };

describe("shouldOfferInstall", () => {
  it("niciodată înainte de alegerea cookie (fără două overlay-uri simultan)", () => {
    expect(shouldOfferInstall({ ...base, consentDecided: false, visits: 10, sessionPageViews: 10 })).toBe(false);
  });
  it("nu la prima pagină din prima vizită", () => {
    expect(shouldOfferInstall(base)).toBe(false);
  });
  it("după implicare: a 2-a vizită sau 3 pagini", () => {
    expect(shouldOfferInstall({ ...base, visits: 2 })).toBe(true);
    expect(shouldOfferInstall({ ...base, sessionPageViews: 3 })).toBe(true);
  });
  it("respectă refuzul 14 zile", () => {
    const dismissedAt = base.now - 1000;
    expect(shouldOfferInstall({ ...base, visits: 5, dismissedAt })).toBe(false);
    expect(shouldOfferInstall({ ...base, visits: 5, dismissedAt: base.now - INSTALL_REPROMPT_MS - 1 })).toBe(true);
  });
});

describe("contoare", () => {
  it("numără o vizită per sesiune", () => {
    const local = memoryStore();
    const s1 = memoryStore();
    expect(countVisit(local, s1)).toBe(1);
    expect(countVisit(local, s1)).toBe(1);
    expect(countVisit(local, memoryStore())).toBe(2);
  });
  it("numără paginile din sesiune", () => {
    const s = memoryStore();
    countPageView(s);
    expect(countPageView(s)).toBe(2);
  });
  it("citește momentul refuzului", () => {
    const local = memoryStore();
    expect(readDismissedAt(local)).toBeNull();
    local.setItem(STORAGE.dismissed, "1");
    local.setItem(STORAGE.dismissedAt, "123");
    expect(readDismissedAt(local)).toBe(123);
  });
});
