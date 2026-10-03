import { describe, it, expect, vi, afterEach } from "vitest";
import { assertPublicHttpsUrl, isPrivateIp, parsePublicHttpsUrl, safeFetch, UnsafeUrlError } from "@/lib/security/ssrf";

const publicDns = async () => ["93.184.216.34"];
const privateDns = async () => ["93.184.216.34", "10.0.0.5"];

function reason(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof UnsafeUrlError ? e.reason : "other";
  }
}

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ])("blocks %s", (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isPrivateIp(ip)).toBe(false),
  );
});

describe("parsePublicHttpsUrl", () => {
  it("requires https", () => expect(reason(() => parsePublicHttpsUrl("http://erp.example.com"))).toBe("https_required"));
  it("rejects localhost and internal names", () => {
    expect(reason(() => parsePublicHttpsUrl("https://localhost/x"))).toBe("blocked_host");
    expect(reason(() => parsePublicHttpsUrl("https://redis/x"))).toBe("blocked_host");
    expect(reason(() => parsePublicHttpsUrl("https://db.internal/x"))).toBe("blocked_host");
  });
  it("rejects private IP literals (incl. decimal form and IPv6)", () => {
    expect(reason(() => parsePublicHttpsUrl("https://169.254.169.254/latest"))).toBe("private_address");
    expect(reason(() => parsePublicHttpsUrl("https://2130706433/"))).toBe("private_address");
    expect(reason(() => parsePublicHttpsUrl("https://[::1]/"))).toBe("private_address");
  });
  it("rejects credentials and odd ports", () => {
    expect(reason(() => parsePublicHttpsUrl("https://u:p@erp.example.com"))).toBe("credentials_in_url");
    expect(reason(() => parsePublicHttpsUrl("https://erp.example.com:6379"))).toBe("port_not_allowed");
  });
  it("accepts a normal public https URL", () => {
    expect(parsePublicHttpsUrl("https://erp.example.com/api").hostname).toBe("erp.example.com");
  });
});

describe("assertPublicHttpsUrl (DNS)", () => {
  it("rejects a hostname that resolves to any private address", async () => {
    await expect(assertPublicHttpsUrl("https://evil.example.com", privateDns)).rejects.toMatchObject({
      reason: "private_address",
    });
  });
  it("accepts a hostname with only public addresses", async () => {
    await expect(assertPublicHttpsUrl("https://erp.example.com", publicDns)).resolves.toBeInstanceOf(URL);
  });
  it("fails closed on DNS errors", async () => {
    await expect(
      assertPublicHttpsUrl("https://nx.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ reason: "dns_failed" });
  });
});

describe("safeFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses to follow redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch("https://erp.example.com", {}, publicDns)).rejects.toMatchObject({ reason: "redirect_blocked" });
    expect(fetchMock).toHaveBeenCalledWith("https://erp.example.com/", expect.objectContaining({ redirect: "manual" }));
  });

  it("never calls fetch for a private target", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch("https://evil.example.com", {}, privateDns)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
