"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import IncomingCallDialog from "./IncomingCallDialog";
import { CALLS_ENABLED, useCalls } from "./useCalls";

// SDK-ul RealtimeKit (greu) se încarcă doar când pornește un apel.
const ActiveCallOverlay = dynamic(() => import("./ActiveCallOverlay"), { ssr: false });

/**
 * Soneria globală: ascultă apelurile primite (SSE + Web Push pe server) și
 * afișează dialogul + apelul activ oriunde e montată — nu doar în conversație.
 * Se montează o singură dată în AppShell; vizitatorii fără cont fac o singură
 * sondă (401) și nu deschid SSE.
 */
export default function GlobalCallHost() {
  if (!CALLS_ENABLED) return null;
  return <CallHostInner />;
}

function CallHostInner() {
  const t = useTranslations("messenger.incomingCall");
  const calls = useCalls({ global: true });
  const caller = calls.incoming?.caller;
  const callerName = caller ? caller.display_name || (caller.username ? `@${caller.username}` : t("unknownCaller")) : "";

  return (
    <>
      {calls.active ? (
        <ActiveCallOverlay authToken={calls.active.authToken} callType={calls.active.callType} onDisconnect={calls.end} />
      ) : null}
      {calls.incoming ? (
        <IncomingCallDialog
          callerName={callerName}
          callerAvatar={caller?.avatar_url || undefined}
          callType={calls.incoming.call_type}
          onAccept={calls.accept}
          onReject={calls.decline}
        />
      ) : null}
    </>
  );
}
