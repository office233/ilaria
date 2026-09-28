"use client";
import { useEffect, useState } from "react";
import { isNativeAppClient } from "@/lib/media/native-app";

/**
 * true în shell-ul nativ (Capacitor iOS/Android) — acolo cumpărarea deblocărilor
 * digitale e ascunsă (reguli IAP Apple/Google, vezi `lib/media/native-app.ts`).
 * `false` la randarea pe server și până la montare (web-ul nu clipește).
 */
export function useIsNativeApp(): boolean {
    const [native, setNative] = useState(false);
    useEffect(() => setNative(isNativeAppClient()), []);
    return native;
}
