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

/** Expand IPv6 before checking prefixes; URL canonicalization turns dotted
 * mapped addresses into hex (e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1). */
function ipv6Words(ip: string): number[] {
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const bytes = dotted[1].split(".").map(Number);
    ip = ip.slice(0, -dotted[1].length) +
      ((bytes[0] << 8) | bytes[1]).toString(16) + ":" +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const [left, right] = ip.split("::");
  const leading = left ? left.split(":").map((word) => parseInt(word, 16)) : [];
  if (right === undefined) return leading;
  const trailing = right ? right.split(":").map((word) => parseInt(word, 16)) : [];
  return [...leading, ...Array<number>(8 - leading.length - trailing.length).fill(0), ...trailing];
}

export function isPrivateIp(ip: string): boolean {
  const address = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const kind = net.isIP(address);
  if (kind === 4) return BLOCKED_V4.some(([base, bits]) => inCidr4(address, base, bits));
  if (kind !== 6) return true; // nu e IP valid → tratăm ca nesigur
  if (address.includes("%")) return true; // scoped interfaces are never public targets
  const words = ipv6Words(address);
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    const embedded = [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join(".");
    return isPrivateIp(embedded);
  }
  // Only ordinary global unicast is eligible. This also excludes NAT64,
  // discard-only, unique-local, link/site-local, multicast and reserved space.
  // Special-purpose prefixes inside global unicast remain blocked (IANA
  // IPv6 Special-Purpose Address Registry, including 3fff::/20 documentation).
  if ((words[0] & 0xe000) !== 0x2000) return true;
  if (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) return true;
  if (words[0] === 0x2002) return true;
  if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return true;
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
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
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
