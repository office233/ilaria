import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCurrencyPreferenceCookie, saveI18nPreference } from "@/components/i18n/preferences";

describe("frontend preference recovery", () => {
  const fetchMock = vi.fn();
  const cookieWrites: string[] = [];
  beforeEach(() => {
    fetchMock.mockReset();
    cookieWrites.length = 0;
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { set cookie(value: string) { cookieWrites.push(value); } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ignores malformed percent-encoded currency cookies instead of crashing hydration", () => {
    expect(readCurrencyPreferenceCookie("other=1; swypik_currency=%E0%A4%A")).toBeNull();
    expect(readCurrencyPreferenceCookie("swypik_currency=not-a-currency")).toBeNull();
    expect(readCurrencyPreferenceCookie("other=1; swypik_currency=EUR")).toBe("EUR");
  });

  it("persists currency and resolves safely after a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(saveI18nPreference({ currency: "EUR" })).resolves.toBeUndefined();
    expect(cookieWrites).toContain("swypik_currency=EUR; Path=/; Max-Age=31536000; SameSite=Lax");
  });

  it("persists locale even when the preference endpoint returns an error response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await saveI18nPreference({ locale: "de" });
    expect(cookieWrites).toContain("swypik_locale=de; Path=/; Max-Age=31536000; SameSite=Lax");
    expect(fetchMock).toHaveBeenCalledWith("/api/i18n/preferences", expect.objectContaining({ body: '{"locale":"de"}' }));
  });
});
