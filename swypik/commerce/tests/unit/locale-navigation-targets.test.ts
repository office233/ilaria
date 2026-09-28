import { describe, expect, it } from "vitest";
import { isNonLocalizedPath } from "@/lib/i18n/non-localized";
import { verticalItemHref } from "@/app/[locale]/v/[id]/item-href";

describe("isNonLocalizedPath", () => {
  it("flags back-office, auth and API routes (no locale prefix exists for them)", () => {
    for (const href of ["/admin", "/admin/news", "/seller", "/creator/live", "/auth/login?next=/fleet", "/api/auth", "/courier", "/onboarding", "/cauze/x", "/r/abc", "/feed.xml", "/sitemap.xml"]) {
      expect(isNonLocalizedPath(href)).toBe(true);
    }
  });

  it("keeps localized pages localized, including look-alike prefixes", () => {
    for (const href of ["/", "/account", "/become-a-seller", "/become-a-creator", "/sellers/1", "/reels", "/search?q=admin", "/explore#auth"]) {
      expect(isNonLocalizedPath(href)).toBe(false);
    }
  });

  it("treats external / non-path hrefs as not ours to localize", () => {
    expect(isNonLocalizedPath("https://anpc.ro")).toBe(true);
    expect(isNonLocalizedPath("mailto:x@y.z")).toBe(true);
  });
});

describe("verticalItemHref", () => {
  it("opens the product page by id (the old /p/<slug> route does not exist)", () => {
    const href = verticalItemHref({ video: { id: "v1" }, entity: { id: "42" } });
    expect(href).toBe("/product/42");
    expect(href.startsWith("/p/")).toBe(false);
  });

  it("falls back to the clip in explore when there is no product", () => {
    expect(verticalItemHref({ video: { id: "v 1" }, entity: null })).toBe("/explore?v=v%201");
  });
});
