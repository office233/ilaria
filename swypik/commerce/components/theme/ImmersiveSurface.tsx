"use client";

import { useEffect, type ReactNode } from "react";
import { immersiveStore } from "@/lib/theme/immersive-store";
import { cn } from "@/lib/ui/cn";

export type ImmersiveSurfaceProps = {
  children: ReactNode;
  /**
   * Ecran complet (feed vertical, player): fără padding pentru BottomNav în
   * #main-content — conținutul își gestionează singur spațiul de jos.
   */
  fullscreen?: boolean;
  className?: string;
};

/**
 * Forțează tema întunecată pentru un subarbore, indiferent de tema aleasă:
 * feed video, player, Movies, Music, Live. Tokenurile (bg-canvas, text-fg…)
 * și variantele `dark:` se rezolvă pe dark în interior; bara de sistem și
 * BottomNav trec automat pe negru cât timp e montat.
 */
export default function ImmersiveSurface({ children, fullscreen = false, className }: ImmersiveSurfaceProps) {
  useEffect(() => immersiveStore.enter(), []);
  return (
    <div
      data-theme="dark"
      data-immersive=""
      {...(fullscreen ? { "data-immersive-fullscreen": "" } : {})}
      className={cn("bg-canvas text-fg", fullscreen ? "min-h-dvh" : "min-h-[calc(100dvh-var(--bottom-inset,0px))]", className)}
    >
      {children}
    </div>
  );
}
