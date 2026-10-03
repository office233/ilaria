import { describe, expect, it } from "vitest";
import { DonationCreateSchema } from "@/lib/validation/schemas";

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

describe("DonationCreateSchema money boundary", () => {
  it("outputs exact amount_cents", () => {
    expect(
      DonationCreateSchema.parse({ campaign_id: CAMPAIGN, amount: "10.10" }),
    ).toMatchObject({ campaign_id: CAMPAIGN, amount_cents: 1010 });

    expect(
      DonationCreateSchema.parse({ campaign_id: CAMPAIGN, amount: 0.29 + 0.71 }),
    ).toMatchObject({ amount_cents: 100 });
  });

  it("rejects values that require rounding or exceed limits", () => {
    expect(
      DonationCreateSchema.safeParse({ campaign_id: CAMPAIGN, amount: "1.005" }).success,
    ).toBe(false);
    expect(
      DonationCreateSchema.safeParse({ campaign_id: CAMPAIGN, amount: "0.99" }).success,
    ).toBe(false);
    expect(
      DonationCreateSchema.safeParse({ campaign_id: CAMPAIGN, amount: "50000.01" }).success,
    ).toBe(false);
  });
});
