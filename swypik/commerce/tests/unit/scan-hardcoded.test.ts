import { describe, expect, it } from "vitest";
import { isHardcodedUiText, scanSource } from "../../scripts/scan-hardcoded.mjs";

describe("isHardcodedUiText", () => {
  it.each(["Despre Swypik", "Cerere retur", "Loading...", "No Image"])("flags %j", (text) => {
    expect(isHardcodedUiText(text)).toBe(true);
  });

  it.each(["Swypik", "{t('x')}", "nume@email.ro", "nume@magazin.ro", "https://x.y"])("ignores %j", (text) => {
    expect(isHardcodedUiText(text)).toBe(false);
  });
});

describe("scanSource", () => {
  it("reports hardcoded JSX text and attributes", () => {
    const src = [
      `<h1 className="x">Despre Swypik</h1>`,
      `<div>No Image</div>`,
      `<textarea aria-label="Cerere retur" />`,
    ].join("\n");
    expect(scanSource(src).map((h) => h.line)).toEqual([1, 2, 3]);
  });

  it("ignores translated text, brand names and email placeholders", () => {
    const src = [
      `<h1>{t("title")}</h1>`,
      `<span>Swypik</span>`,
      `<input placeholder="nume@email.ro" />`,
    ].join("\n");
    expect(scanSource(src)).toEqual([]);
  });
});
