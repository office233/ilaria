/** Parse a configured origin, never a URL containing credentials or a path. */
export function parseConfiguredOrigin(value: string | null | undefined, allowLoopback = false): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (loopback && !allowLoopback) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowLoopback)) return null;
    if (url.hostname.includes("*") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Trust the application, request origin and explicit extras, not a marketing site. */
export function applicationRequestOrigins(options: {
  appUrl: string;
  requestOrigin: string;
  extraOrigins?: string;
  development?: boolean;
}): string[] {
  const origins = new Set<string>();
  for (const value of [options.appUrl, options.requestOrigin, ...(options.extraOrigins || "").split(",")]) {
    const origin = parseConfiguredOrigin(value, options.development);
    if (origin) origins.add(origin);
  }
  // Preserve the existing www alias, including ports, during the current rollout.
  const appOrigin = parseConfiguredOrigin(options.appUrl, options.development);
  if (appOrigin) {
    const url = new URL(appOrigin);
    if (!url.hostname.startsWith("www.") && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      url.hostname = `www.${url.hostname}`;
      origins.add(url.origin);
    }
  }
  return [...origins];
}
