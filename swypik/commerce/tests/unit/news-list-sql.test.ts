import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { sql: string; params: unknown[] }[] = [];
vi.mock("@/lib/db", () => ({
  dbQuery: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows: [] };
  },
}));

import { listArticles } from "@/lib/news/repository";

/** Fiecare $n din SQL trebuie să aibă un parametru și invers (regresie: LIMIT fără `$`). */
function placeholders(sql: string): number[] {
  return [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
}

describe("listArticles — SQL parametrizat corect", () => {
  beforeEach(() => void calls.splice(0));

  it("prima pagină: LIMIT parametrizat, fără OFFSET", async () => {
    await listArticles({ limit: 5 });
    const { sql, params } = calls[0];
    expect(sql).toMatch(/LIMIT \$1\b/);
    expect(sql).not.toMatch(/OFFSET/);
    expect(Math.max(...placeholders(sql))).toBe(params.length);
  });

  it("cu categorie și offset: placeholder-ele acoperă exact parametrii", async () => {
    await listArticles({ category: "tech" as never, limit: 5, offset: 10 });
    const { sql, params } = calls[0];
    expect(sql).toMatch(/LIMIT \$2 OFFSET \$3\b/);
    expect(params).toEqual(["tech", 5, 10]);
    expect(Math.max(...placeholders(sql))).toBe(params.length);
  });
});
