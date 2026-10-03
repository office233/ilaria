/**
 * Punte opțională către pluginul nativ de localizare în fundal
 * (@capacitor-community/background-geolocation) — audit food-go #10.
 *
 * În aplicația Capacitor, pluginul pornește un foreground service (Android) /
 * „location updates in background" (iOS) și ne cheamă callback-ul și cu
 * aplicația în fundal (șoferul navighează în Maps/Waze). În browser / PWA
 * pluginul lipsește → întoarcem null și hook-ul rămâne pe watchPosition.
 * Planul nativ complet: docs/go/driver-background-location.md.
 */
type Location = { latitude: number; longitude: number; speed?: number | null; bearing?: number | null };
type WatcherOptions = {
  backgroundMessage: string;
  backgroundTitle: string;
  requestPermissions: boolean;
  stale: boolean;
  distanceFilter: number;
};
type BackgroundGeolocationPlugin = {
  addWatcher(opts: WatcherOptions, cb: (loc?: Location, err?: { code?: string }) => void): Promise<string>;
  removeWatcher(opts: { id: string }): Promise<void>;
};

function plugin(): BackgroundGeolocationPlugin | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const p = cap.Plugins?.BackgroundGeolocation as BackgroundGeolocationPlugin | undefined;
  return p && typeof p.addWatcher === "function" ? p : null;
}

export type NativeFix = { lat: number; lng: number; speed_kmh?: number; heading?: number };

/** Pornește urmărirea nativă; întoarce funcția de oprire sau null dacă pluginul lipsește. */
export async function startNativeLocation(
  texts: { title: string; message: string },
  onFix: (fix: NativeFix) => void,
  onError: () => void,
): Promise<(() => void) | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const id = await p.addWatcher(
      { backgroundTitle: texts.title, backgroundMessage: texts.message, requestPermissions: true, stale: false, distanceFilter: 25 },
      (loc, err) => {
        if (err || !loc) return onError();
        onFix({
          lat: loc.latitude,
          lng: loc.longitude,
          speed_kmh: loc.speed != null && loc.speed >= 0 ? loc.speed * 3.6 : undefined,
          heading: loc.bearing != null && loc.bearing >= 0 && loc.bearing < 360 ? loc.bearing : undefined,
        });
      },
    );
    return () => void p.removeWatcher({ id }).catch(() => undefined);
  } catch {
    return null;
  }
}
