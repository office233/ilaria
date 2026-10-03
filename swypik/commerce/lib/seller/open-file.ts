/**
 * Deschide un fișier al sellerului (PDF/XML generat pe server) într-un mod care
 * merge și în WebView-ul aplicației mobile:
 *
 *  - aplicația Capacitor: cere un link semnat și îl deschide în browserul
 *    sistemului (plugin Browser → vizualizare, tipărire, partajare); fără
 *    plugin, foaia de partajare nativă (plugin Share) sau `_system`;
 *  - browser mobil: foaia de partajare web cu fișierul (tipărire/salvare/trimitere);
 *  - desktop: fișierul într-un tab nou (PDF inline → tipărire din vizualizator,
 *    XML → descărcare prin Content-Disposition).
 *
 * Fără `window.print()` și fără `<a download>` pe blob — nu fac nimic în WebView.
 */
import { capacitorBridge, isNativeApp } from "@/lib/native-app";
import { sellerFilePath, type SellerFileKind } from "./file-paths";

export type OpenFileResult = "opened" | "shared" | "failed";

export { isNativeApp };

async function signedUrl(kind: SellerFileKind, id: string): Promise<string | null> {
  const res = await fetch("/api/seller/files/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ kind, id }),
  });
  const data = (await res.json().catch(() => null)) as { success?: boolean; url?: string } | null;
  return res.ok && data?.success && data.url ? data.url : null;
}

function isTouchDevice(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

async function shareAsFile(path: string, filename: string): Promise<boolean> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function" || typeof File === "undefined") return false;
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) return false;
  const blob = await res.blob();
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  if (!nav.canShare({ files: [file] })) return false;
  try {
    await nav.share({ files: [file], title: filename });
    return true;
  } catch (err) {
    // Utilizatorul a închis foaia de partajare — nu e o eroare.
    return (err as { name?: string } | null)?.name === "AbortError";
  }
}

export async function openSellerFile(kind: SellerFileKind, id: string, filename: string): Promise<OpenFileResult> {
  const path = sellerFilePath(kind, id);
  try {
    const cap = capacitorBridge();
    if (cap) {
      const url = await signedUrl(kind, id);
      if (!url) return "failed";
      if (cap.Plugins?.Browser) {
        await cap.Plugins.Browser.open({ url });
        return "opened";
      }
      if (cap.Plugins?.Share) {
        await cap.Plugins.Share.share({ title: filename, url });
        return "shared";
      }
      window.open(url, "_system");
      return "opened";
    }
    if (isTouchDevice() && (await shareAsFile(path, filename))) return "shared";
    // Fără "noopener" în features: atunci window.open întoarce mereu null și nu
    // am putea detecta un popup blocat. Tăiem legătura manual.
    const win = window.open(path, "_blank");
    if (win) win.opener = null;
    else window.location.assign(path);
    return "opened";
  } catch {
    return "failed";
  }
}
