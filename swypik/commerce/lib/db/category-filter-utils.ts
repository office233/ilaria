const ROOT_SCOPE_PREFIX = "__root:";

function normalizeToken(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildScopedTagId(tags: unknown[], rootId?: unknown) {
  const tokens = Array.from(new Set(tags.map(normalizeToken).filter(Boolean)));
  const root = normalizeToken(rootId);
  if (root) tokens.push(`${ROOT_SCOPE_PREFIX}${root}`);
  return tokens.length > 0 ? `tag:${tokens.join("|")}` : "";
}

export function parseScopedTagFilter(value: unknown) {
  const tags: string[] = [];
  const rootIds: string[] = [];

  for (const rawToken of String(value ?? "").split("|")) {
    const token = normalizeToken(rawToken);
    if (!token) continue;

    if (token.startsWith(ROOT_SCOPE_PREFIX)) {
      const rootId = token.slice(ROOT_SCOPE_PREFIX.length).trim();
      if (rootId) rootIds.push(rootId);
      continue;
    }

    tags.push(token);
  }

  return {
    tags: Array.from(new Set(tags)),
    rootIds: Array.from(new Set(rootIds)),
  };
}
