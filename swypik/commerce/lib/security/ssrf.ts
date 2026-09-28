/**
 * Protecție SSRF pentru URL-uri furnizate de utilizatori (webhooks, importuri).
 *
 * Reguli: doar https, fără credențiale în URL, port implicit sau din listă,
 * hostname care NU e loopback/privat/link-local/CGNAT/multicast/rezervat —
 * verificat atât pe literal cât și pe TOATE adresele rezolvate prin DNS.
 * `safeFetch` nu urmează redirect-uri (un 3xx către o adresă internă ar
 * ocoli verificarea). Risc rezidual: DNS rebinding între lookup și connect
 * (fereastră de ms; necesită pinning la nivel de socket pentru eliminare).
 */
import dns from "node:dns";
import net from "node:net";

export class UnsafeUrlError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe_url:${reason}`);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"];
const ALLOWED_PORTS = new Set(["", "443", "8443"]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return BLOCKED_V4.some(([base, bits]) => inCidr4(ip, base, bits));
  if (kind !== 6) return true; // nu e IP valid → tratăm ca nesigur
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateIp(mapped[1]);
  if (v6 === "::" || v6 === "::1") return true;
  const first = parseInt(v6.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (depreciat)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8:") || v6.startsWith("2002:")) return true;
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Validează sintactic URL-ul (fără DNS). Aruncă UnsafeUrlError. */
export function parsePublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid_url");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("https_required");
  if (url.username || url.password) throw new UnsafeUrlError("credentials_in_url");
  if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError("port_not_allowed");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("blocked_host");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UnsafeUrlError("private_address");
  } else if (!host.includes(".")) {
    throw new UnsafeUrlError("blocked_host"); // nume scurte = rețea internă (ex. "redis", "web-next")
  }
  return url;
}

/** Validare completă: sintaxă + toate adresele DNS publice. */
export async function assertPublicHttpsUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  const url = parsePublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return url;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UnsafeUrlError("dns_failed");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("dns_failed");
  if (addresses.some(isPrivateIp)) throw new UnsafeUrlError("private_address");
  return url;
}

/** fetch către un URL extern verificat; redirect-urile sunt refuzate. */
export async function safeFetch(raw: string, init: RequestInit = {}, resolve?: Resolver): Promise<Response> {
  const url = await assertPublicHttpsUrl(raw, resolve);
  const res = await fetch(url.toString(), { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new UnsafeUrlError("redirect_blocked");
  return res;
}
