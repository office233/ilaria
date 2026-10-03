"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, Radio, ShoppingBag, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { useToast } from "@/components/ui/Toast";
import type { LiveShopItem, LiveStreamPublic } from "@/lib/live/queries";
import { LiveStateCard } from "../LiveStateCard";
import type { LivePulse } from "../rtc/client";
import { useHostPublisher } from "../rtc/useHostPublisher";
import { LiveChat } from "../viewer/LiveChat";
import HostRoom from "./HostRoom";
import { StudioProducts } from "./StudioProducts";

type Props = { initialStream: LiveStreamPublic; initialItems: LiveShopItem[]; configured: boolean; pollMs: number };

/**
 * Studio-ul gazdei (telefon sau desktop): „Intră live” → camera se publică în
 * SFU-ul Cloudflare prin API-ul nostru → heartbeat-ul confirmă media → live.
 */
export default function HostStudio({ initialStream, initialItems, configured, pollMs }: Props) {
  const t = useTranslations("live.studio");
  const { toast } = useToast();
  const [stream, setStream] = useState(initialStream);
  const [items, setItems] = useState(initialItems);
  const [connecting, setConnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [productsOpen, setProductsOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const ended = stream.status === "ended" || stream.status === "failed";
  const onPulse = useCallback((pulse: LivePulse) => {
    setStream((s) => ({ ...s, status: pulse.status, viewer_count: pulse.viewers }));
  }, []);
  const publisher = useHostPublisher(stream.id, configured && connecting && !ended, attempt, onPulse);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/live/streams/${stream.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { stream: LiveStreamPublic; items: LiveShopItem[] };
      setStream(data.stream);
      setItems(data.items);
    } catch {
      // rețea — următorul tick
    }
  }, [stream.id]);

  useEffect(() => {
    if (ended) return;
    const timer = setInterval(() => void refresh(), connecting ? Math.min(pollMs, 5000) : pollMs);
    return () => clearInterval(timer);
  }, [refresh, ended, connecting, pollMs]);

  const publishError = publisher.state.status === "error" ? publisher.state.code : null;
  useEffect(() => {
    if (!publishError) return;
    toast({ title: publishError === "permission_denied" ? t("cameraBlocked") : t("tokenError"), tone: "danger" });
    setConnecting(false);
  }, [publishError, t, toast]);

  const endStream = async () => {
    setEnding(true);
    try {
      const res = await fetch(`/api/live/streams/${stream.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ended" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setConnecting(false);
      setConfirmEnd(false);
      await refresh();
    } catch {
      toast({ title: t("endError"), tone: "danger" });
    } finally {
      setEnding(false);
    }
  };

  let stage;
  if (!configured) stage = <LiveStateCard kind="unconfigured" />;
  else if (ended) stage = <LiveStateCard kind="ended" />;
  else if (connecting) {
    stage = (
      <HostRoom
        media={publisher.media}
        micOn={publisher.micOn}
        camOn={publisher.camOn}
        onToggleMic={publisher.toggleMic}
        onToggleCam={publisher.toggleCam}
      />
    );
  } else {
    stage = (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-gutter text-center">
        <Radio className="h-10 w-10 text-danger" aria-hidden />
        <p className="max-w-xs text-sm text-muted">{t("readyHint")}</p>
        <Button size="lg" onClick={() => { setAttempt((a) => a + 1); setConnecting(true); }}>
          {t("goLive")}
        </Button>
      </div>
    );
  }

  return (
    // Peste layout-ul dashboard-ului creatorului: ecran complet pe telefon și desktop.
    <div className="fixed inset-0 z-overlay h-dvh w-full overflow-hidden bg-canvas text-fg">
      <div className="absolute inset-0">{stage}</div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/60 to-transparent px-gutter pb-8 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] text-white">
        <IconButton asChild variant="overlay" label={t("back")} className="pointer-events-auto">
          <Link href="/creator/live">
            <ArrowLeft aria-hidden />
          </Link>
        </IconButton>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{stream.title}</p>
        {stream.status === "live" ? (
          <>
            <Badge tone="danger" className="bg-danger text-white">{t("liveBadge")}</Badge>
            <Badge tone="overlay">
              <Eye className="h-3.5 w-3.5" aria-hidden />
              {stream.viewer_count}
            </Badge>
          </>
        ) : connecting ? (
          <Badge tone="overlay">{t("waitingConfirmation")}</Badge>
        ) : null}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-2 bg-gradient-to-t from-black/60 to-transparent px-gutter pb-[calc(var(--bottom-inset)+0.75rem)] pt-16">
        {stream.status === "live" ? <LiveChat streamId={stream.id} canChat signedIn isHost /> : null}
        {!ended ? (
          <div className="pointer-events-auto flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setProductsOpen(true)}>
              <ShoppingBag className="h-4 w-4" aria-hidden />
              {t("products", { count: items.length })}
            </Button>
            <Button variant="danger" size="sm" className="ml-auto" onClick={() => setConfirmEnd(true)}>
              <Square className="h-4 w-4" aria-hidden />
              {t("endStream")}
            </Button>
          </div>
        ) : null}
      </div>

      <StudioProducts streamId={stream.id} items={items} open={productsOpen} onOpenChange={setProductsOpen} onChanged={() => void refresh()} />
      <Dialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title={t("confirmEndTitle")}
        description={t("confirmEndDescription")}
        footer={
          <Button variant="danger" block loading={ending} onClick={() => void endStream()}>
            {t("endStream")}
          </Button>
        }
      />
    </div>
  );
}
