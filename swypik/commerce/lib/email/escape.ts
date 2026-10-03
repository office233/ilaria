/** Escapare HTML pentru orice valoare venită de la utilizatori în emailuri. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Un subiect de email pe o singură linie (fără injecție de antete). */
export function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

/** Mascare pentru loguri — nu scriem adrese complete (PII). */
export function maskEmail(e: string | null | undefined): string {
  if (!e || typeof e !== "string" || !e.includes("@")) return "<none>";
  const [user, domain] = e.split("@");
  return `${user.slice(0, 2)}***@${domain}`;
}
