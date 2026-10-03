/**
 * Detectarea aplicației mobile (WebView Capacitor care încarcă swypik.com).
 * Capacitor injectează `window.Capacitor` în pagină; în browser nu există.
 */
export type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  Plugins?: {
    Browser?: { open: (o: { url: string }) => Promise<void> };
    Share?: { share: (o: { title?: string; url?: string }) => Promise<unknown> };
  };
};

export function capacitorBridge(): CapacitorBridge | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return cap?.isNativePlatform?.() ? cap : null;
}

/** Rulăm în aplicația nativă (WebView Capacitor)? */
export function isNativeApp(): boolean {
  return capacitorBridge() !== null;
}
