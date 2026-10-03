/**
 * Escapare HTML pentru textele introduse de utilizatori care ajung în emailurile
 * trimise din rutele de flotă (nume, oraș, vehicul). Audit food-go #22.
 */
const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => MAP[ch] ?? ch);
}
