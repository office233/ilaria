import type { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";

export type AdminColumn<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "start" | "end";
  /** Pe mobil: afișat ca titlu al cardului (nu ca rând etichetă/valoare). */
  primary?: boolean;
};

/**
 * Tabel de admin: tabel clasic de la `md` în sus, carduri pe telefon
 * (fără scroll lateral). Server-compatible — fără hooks.
 */
export function AdminTable<T>({
  rows,
  columns,
  rowKey,
  actions,
  empty,
  caption,
}: {
  rows: T[];
  columns: AdminColumn<T>[];
  rowKey: (row: T) => string;
  actions?: (row: T) => ReactNode;
  empty?: ReactNode;
  caption?: string;
}) {
  if (rows.length === 0) return <>{empty ?? null}</>;
  const primary = columns.filter((c) => c.primary);
  const secondary = columns.filter((c) => !c.primary);

  return (
    <>
      <ul className="space-y-3 md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="rounded-card border border-subtle bg-surface p-4">
            <div className="space-y-1">
              {primary.map((c) => (
                <div key={c.key} className="min-w-0">{c.cell(row)}</div>
              ))}
            </div>
            {secondary.length > 0 ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                {secondary.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-xs text-subtle">{c.header}</dt>
                    <dd className="truncate text-fg">{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions(row)}</div> : null}
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-card border border-subtle bg-surface md:block">
        <table className="w-full text-left text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="border-b border-subtle bg-surface-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn("px-4 py-3", c.align === "end" && "text-right")}>
                  {c.header}
                </th>
              ))}
              {actions ? <th scope="col" className="px-4 py-3" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-subtle">
            {rows.map((row) => (
              <tr key={rowKey(row)} className="align-middle hover:bg-surface-2/50">
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-4 py-3", c.align === "end" && "text-right tabular-nums")}>
                    {c.cell(row)}
                  </td>
                ))}
                {actions ? (
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">{actions(row)}</div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
