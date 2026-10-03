import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicHttpsUrl, isPrivateIp, parsePublicHttpsUrl, safeFetch } from "@/lib/security/ssrf";

afterEach(() => vi.unstubAllGlobals());
describe("SSRF IPv6 canonicalization", () => {
  it.each([
    "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:101",
    "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0", "::7f00:1",
    "0064:ff9b::a00:1", "64:ff9b:1::1", "100::1", "2001:db8::1", "2001:0db8::1",
    "2001:2::1", "2002:a00:1::1", "3fff::1", "5f00::1", "fe80::1%eth0",
  ])("rejects private or special-use IPv6 %s", (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2a00:1450:4001::1", "::ffff:808:808", "::ffff:8.8.8.8"])("preserves public address %s", (address) => {
    expect(isPrivateIp(address)).toBe(false);
  });

  it("rejects mapped dotted IPv4 even after the URL parser changes it to hex", () => {
    expect(() => parsePublicHttpsUrl("https://[::ffff:127.0.0.1]/private")).toThrow("private_address");
  });

  it.each(["localhost.", "db.internal.", "redis."])("rejects a DNS root dot bypass for %s", (host) => {
    expect(() => parsePublicHttpsUrl(`https://${host}/`)).toThrow("blocked_host");
  });

  it("rejects private mapped IPv6 from any DNS answer", async () => {
    await expect(assertPublicHttpsUrl("https://evil.example.com", async () => ["1.1.1.1", "::ffff:a00:1"]))
      .rejects.toMatchObject({ reason: "private_address" });
  });

  it("never sends credentials to an IPv6-mapped private target", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch("https://[::ffff:169.254.169.254]/", { headers: { Authorization: "Basic test" } }))
      .rejects.toMatchObject({ reason: "private_address" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
