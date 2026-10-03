/**
 * Validates URLs accepted from end-users for return evidence and similar flows.
 * - Must be https
 * - Hostname must be in our R2/Cloudflare/Stripe whitelist
 * - Rejects raw IPs, userinfo, ports, and any other protocol
 *
 * This guards against SSRF and phishing via attacker-controlled URLs stored
 * on commerce_orders.metadata.return_evidence_urls (then rendered to admins
 * and sellers).
 */

const ALLOWED_EVIDENCE_HOSTS = [
  "media.swypik.com",
  "swypik-media.r2.cloudflarestorage.com",
  "files.stripe.com",
];

export function isSafeEvidenceUrl(input: unknown): boolean {
  if (typeof input !== "string" || !input) return false;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  // reject raw IPv4/IPv6
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (host.includes(":")) return false;
  return ALLOWED_EVIDENCE_HOSTS.some(
    (h) => host === h || host.endsWith("." + h),
  );
}
