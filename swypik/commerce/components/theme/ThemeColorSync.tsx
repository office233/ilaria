"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { immersiveStore } from "@/lib/theme/immersive-store";
import { themeColorFor } from "@/lib/theme/theme-color";

/**
 * Ține `<meta name="theme-color">` sincronizat cu tema aleasă (nu doar cu
 * sistemul) și cu suprafețele imersive (bara de sistem neagră pe feed/player).
 */
export default function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  const immersive = useSyncExternalStore(
    immersiveStore.subscribe,
    immersiveStore.getSnapshot,
    immersiveStore.getServerSnapshot,
  );

  useEffect(() => {
    const color = themeColorFor(resolvedTheme, immersive);
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (metas.length === 0) {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = color;
      document.head.appendChild(meta);
      return;
    }
    metas.forEach((m) => {
      m.content = color;
    });
  }, [resolvedTheme, immersive]);

  return null;
}
