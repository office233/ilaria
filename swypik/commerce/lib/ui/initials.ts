/** Inițialele unui nume („Ana Maria Pop” → „AP”); „?” când lipsește. */
export function initialsOf(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0] ?? "")[0] ?? "";
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1] ?? "")[0] ?? "" : "";
  return (first + last).toUpperCase();
}
