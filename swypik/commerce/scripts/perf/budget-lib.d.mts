export interface BudgetOptions {
  tolerancePct: number;
  toleranceKb: number;
  capKb: number;
}

export interface NextManifests {
  appBuildManifest?: { pages?: Record<string, string[]> } | null;
  buildManifest?: {
    rootMainFiles?: string[];
    polyfillFiles?: string[];
    pages?: Record<string, string[]>;
  } | null;
}

export type RowStatus = "ok" | "grew" | "new" | "new-over-cap" | "removed";

export interface BudgetRow {
  route: string;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  status: RowStatus;
}

export interface ParsedArgs extends BudgetOptions {
  update: boolean;
  json: boolean;
  help: boolean;
  distDir: string;
  baselinePath: string;
}

export const DEFAULTS: Readonly<BudgetOptions>;
export function normalizeAppRoute(entry: string): string | null;
export function collectRouteFiles(manifests: NextManifests): Map<string, string[]>;
export function computeFirstLoad(
  routeFiles: Map<string, string[]>,
  sizeOf: (file: string) => number | null | undefined,
): { sizes: Record<string, number>; missing: string[] };
export function allowedGrowth(baselineBytes: number, opts: Pick<BudgetOptions, "tolerancePct" | "toleranceKb">): number;
export function compareToBaseline(
  current: Record<string, number>,
  baselineRoutes: Record<string, number>,
  opts?: Partial<BudgetOptions>,
): { rows: BudgetRow[]; failures: BudgetRow[]; ok: boolean };
export function formatKb(bytes: number | null | undefined): string;
export function formatTable(rows: BudgetRow[]): string;
export function parseArgs(argv: string[], env?: Record<string, string | undefined>): ParsedArgs;
export function buildBaseline(
  sizes: Record<string, number>,
  meta?: Record<string, unknown>,
): { meta: Record<string, unknown>; routes: Record<string, number> };
