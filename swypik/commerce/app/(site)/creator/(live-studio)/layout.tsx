import type { ReactNode } from "react";

/**
 * Studio-ul Live stă în afara layout-ului `(dashboard)` al Creator Studio:
 * acela admite doar creator/admin, dar și sellerii pot vinde live (API-urile
 * `/api/live/*` și paginile de aici verifică singure rolul creator/seller/admin).
 */
export default function LiveStudioLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <main className="mx-auto w-full max-w-5xl px-gutter py-4 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
