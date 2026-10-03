import type { ReactNode } from "react";

/**
 * Bara de acțiuni fixă jos (mobil). `--bottom-inset` = zona sigură a telefonului
 * (fluxul de creare ascunde BottomNav), deci bara nu intră sub bara de gesturi.
 */
export function StickyActions({ children }: { children: ReactNode }) {
  return (
    <>
      <div aria-hidden className="h-20" />
      <div className="fixed inset-x-0 z-header border-t border-subtle bg-surface/95 backdrop-blur-xl" style={{ bottom: "var(--bottom-inset, 0px)" }}>
        <div className="mx-auto flex w-full max-w-md items-center gap-2 px-gutter py-3">{children}</div>
      </div>
    </>
  );
}
