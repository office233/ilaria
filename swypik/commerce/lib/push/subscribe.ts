/**
 * Push subscription helper.
 * Wraps the dance: ServiceWorker register → permission → VAPID fetch →
 * pushManager.subscribe → POST /api/notifications/subscribe.
 *
 * Uses /sw-push.js (the dedicated push worker) so we don't collide with
 * the workbox-generated /sw.js used for offline caching.
 */

export type SubscribeResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: "unsupported" | "denied" | "default" | "no_vapid" | "error"; message?: string };

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function isPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function subscribeToPush(): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: "unsupported" };

  const permission = await Notification.requestPermission();
  if (permission === "denied") return { ok: false, reason: "denied" };
  if (permission !== "granted") return { ok: false, reason: "default" };

  try {
    const reg =
      (await navigator.serviceWorker.getRegistration("/sw-push.js")) ||
      (await navigator.serviceWorker.register("/sw-push.js"));
    await navigator.serviceWorker.ready;

    const keyRes = await fetch("/api/push/vapid-public-key");
    const { key } = (await keyRes.json()) as { key?: string };
    if (!key) return { ok: false, reason: "no_vapid" };

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
    }

    const json = sub.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };

    const res = await fetch("/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent,
      }),
    });

    if (!res.ok) return { ok: false, reason: "error", message: `HTTP ${res.status}` };
    return { ok: true, endpoint: json.endpoint || sub.endpoint };
  } catch (err) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function unsubscribeFromPush(): Promise<{ ok: boolean; reason?: string }> {
  if (!isPushSupported()) return { ok: false, reason: "unsupported" };
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return { ok: true };
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch("/api/notifications/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function getPushSubscriptionState(): Promise<{
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}> {
  if (!isPushSupported()) {
    return { supported: false, permission: "unsupported", subscribed: false };
  }
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
    const sub = await reg?.pushManager.getSubscription();
    subscribed = !!sub;
  } catch {
    /* no-op */
  }
  return { supported: true, permission: Notification.permission, subscribed };
}
