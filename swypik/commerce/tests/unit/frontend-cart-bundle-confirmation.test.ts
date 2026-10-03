import { describe, expect, it, vi } from "vitest";
import { addCartBundle } from "@/components/chat/addCartBundle";

describe("chat bundle cart confirmations", () => {
  it("reports success only after every product was confirmed", async () => {
    const added: string[] = [];
    const add = vi.fn(async (product: string) => { added.push(product); return true; });
    await expect(addCartBundle(["a", "b", "c"], add)).resolves.toBe(true);
    expect(added).toEqual(["a", "b", "c"]);
  });

  it("does not report full bundle success when a variant is unavailable", async () => {
    const add = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(addCartBundle(["a", "b", "c"], add)).resolves.toBe(false);
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("waits for the first response so anonymous-cart cookies are available to the next request", async () => {
    let finish: (result: boolean) => void = () => undefined;
    const add = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; })).mockResolvedValue(true);
    const result = addCartBundle(["a", "b"], add);
    expect(add).toHaveBeenCalledTimes(1);
    finish(true);
    await expect(result).resolves.toBe(true);
    expect(add).toHaveBeenCalledTimes(2);
  });
});
