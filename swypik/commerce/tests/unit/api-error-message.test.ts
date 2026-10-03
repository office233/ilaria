import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "@/lib/i18n/api-error";

describe("apiErrorMessage", () => {
  const validation = { error: "Adresă prea scurtă", code: "validation_error" };

  it("shows the raw validation message for ro", () => {
    expect(apiErrorMessage(validation, "ro", "fallback")).toBe("Adresă prea scurtă");
  });

  it("hides the raw validation message for other locales", () => {
    for (const locale of ["en", "es", "fr", "de", "pt", "it"]) {
      expect(apiErrorMessage(validation, locale, "fallback")).toBe("fallback");
    }
  });

  it("keeps non-validation errors as before", () => {
    expect(apiErrorMessage({ error: "Slot ocupat" }, "en", "fallback")).toBe("Slot ocupat");
  });

  it("falls back when there is no usable error", () => {
    expect(apiErrorMessage(null, "en", "fallback")).toBe("fallback");
    expect(apiErrorMessage({ error: "  " }, "ro", "fallback")).toBe("fallback");
    expect(apiErrorMessage({ error: 42 }, "ro", "fallback")).toBe("fallback");
  });
});
