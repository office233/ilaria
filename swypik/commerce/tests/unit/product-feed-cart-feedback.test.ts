import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("ProductFeed cart feedback", () => {
  it("waits for server-confirmed cart success before showing Added/tracking", () => {
    const feed = fs.readFileSync(
      path.join(process.cwd(), "components/ProductFeed.tsx"),
      "utf8",
    );
    const chat = fs.readFileSync(
      path.join(process.cwd(), "components/ChatInterface.tsx"),
      "utf8",
    );

    expect(feed).toContain("Promise<boolean>");
    expect(feed).toContain("const added = await onAddToCart(product, 1)");
    expect(feed).toContain("if (!added) return");
    expect(feed.indexOf('sendFeedEvent("add_to_cart"')).toBeGreaterThan(
      feed.indexOf("if (!added) return"),
    );
    expect(chat).toContain('setToastMessage(t("adaugareInCosEsuata"))');
    expect(chat).toContain("return false");
    expect(chat).toContain("return true");
  });

  it("navigates to checkout only after the buy-now cart add succeeded", () => {
    const feed = fs.readFileSync(
      path.join(process.cwd(), "components/ProductFeed.tsx"),
      "utf8",
    );
    expect(feed).toContain('if (await handleAddToCart(product)) router.push("/checkout")');
    expect(feed).not.toMatch(/void handleAddToCart\(product\);\s*router\.push\("\/checkout"\)/);
  });
});
