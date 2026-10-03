"use client";

import { useEffect, useState } from "react";
import { isConstrainedNetwork, type NetworkInfo } from "./feed-preload";

/** Network Information API (Chromium/Android) — lipsește din lib.dom. */
type NetworkConnection = NetworkInfo & EventTarget;

function connection(): NetworkConnection | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: NetworkConnection }).connection;
}

/** true pe Data Saver / 2G → feed-ul nu preîncarcă nimic în afara clipului activ. */
export function useNetworkConstrained(): boolean {
  const [constrained, setConstrained] = useState(() => isConstrainedNetwork(connection()));

  useEffect(() => {
    const conn = connection();
    if (!conn) return;
    const update = () => setConstrained(isConstrainedNetwork(conn));
    update();
    conn.addEventListener("change", update);
    return () => conn.removeEventListener("change", update);
  }, []);

  return constrained;
}
