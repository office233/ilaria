"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "@/lib/i18n/navigation";

const AppMenu = dynamic(() => import("./AppMenu"), { ssr: false });

type AppMenuApi = { open: boolean; setOpen: (open: boolean) => void; toggle: () => void };

const AppMenuContext = createContext<AppMenuApi | null>(null);

/**
 * Meniul aplicației (☰) — montat o singură dată în AppShell, disponibil din
 * orice pagină prin <AppMenuButton> sau `useAppMenu()`. Se închide la navigare
 * și la orice click pe un link din meniu (inclusiv ruta curentă — vezi AppMenu).
 */
export default function AppMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const api = useMemo(() => ({ open, setOpen, toggle }), [open, toggle]);

  return (
    <AppMenuContext.Provider value={api}>
      {children}
      {loaded ? <AppMenu open={open} onOpenChange={setOpen} /> : null}
    </AppMenuContext.Provider>
  );
}

/** `null` în afara AppShell (ex. pagina 404 globală) — butoanele se ascund. */
export function useAppMenu(): AppMenuApi | null {
  return useContext(AppMenuContext);
}
