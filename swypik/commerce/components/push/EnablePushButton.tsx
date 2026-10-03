"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

/**
 * EnablePushButton — registers the Web Push service worker, requests
 * notification permission, subscribes the browser, and POSTs the
 * subscription to /api/notifications/subscribe.
 *
 * Idempotent: safe to click multiple times. On unsupported browsers it
 * renders disabled.
 */

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

type Status = "idle" | "loading" | "subscribed" | "denied" | "unsupported" | "error";

export default function EnablePushButton({ className }: { className?: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("Activeaza notificarile");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    if (!supported) {
      setStatus("unsupported");
      setMessage("Browserul nu suporta notificari");
      return;
    }

    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
        const existing = await reg?.pushManager.getSubscription();
        if (existing) {
          setStatus("subscribed");
          setMessage("Notificari active");
        }
        if (Notification.permission === "denied") {
          setStatus("denied");
          setMessage("Permisiune refuzata");
        }
      } catch {
        /* no-op */
      }
    })();
  }, []);

  const enable = useCallback(async () => {
    setStatus("loading");
    setMessage("Se conecteaza...");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        setMessage("Permisiune refuzata");
        return;
      }

      const reg =
        (await navigator.serviceWorker.getRegistration("/sw-push.js")) ||
        (await navigator.serviceWorker.register("/sw-push.js"));

      await navigator.serviceWorker.ready;

      const keyRes = await fetch("/api/push/vapid-public-key");
      const { key } = await keyRes.json();
      if (!key) {
        setStatus("error");
        setMessage("VAPID key lipseste");
        return;
      }

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(key) as ArrayBuffer,
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

      if (!res.ok) {
        setStatus("error");
        setMessage("Eroare la subscriere");
        return;
      }

      setStatus("subscribed");
      setMessage("Notificari active");
    } catch (err) {
      console.error(err);
      setStatus("error");
      setMessage("A esuat. Incearca din nou.");
    }
  }, []);

  const disabled =
    status === "loading" ||
    status === "subscribed" ||
    status === "denied" ||
    status === "unsupported";

  const Icon = status === "subscribed" ? Bell : BellOff;

  return (
    <button
      type="button"
      onClick={enable}
      disabled={disabled}
      className={
        className ||
        "inline-flex items-center gap-2 rounded-lg bg-[#0D0D0D] px-4 py-2 text-sm font-medium text-white hover:bg-[#0e8e6e] disabled:opacity-60"
      }
    >
      <Icon className="h-4 w-4" />
      <span>{message}</span>
    </button>
  );
}
