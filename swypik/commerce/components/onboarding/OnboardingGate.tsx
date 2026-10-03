"use client";

// Poarta de onboarding, montată în AppShell. Rulează pe client ca root
// layout-ul să nu citească cookies/headers/DB — altfel toate paginile ar fi
// dinamice. Statusul și creatorii sugerați vin din API după montare.
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import OnboardingModal, { type SuggestedCreator } from "./OnboardingModal";

// Odată ce onboarding-ul e confirmat ca terminat, nu mai întrebăm în tab-ul ăsta.
const DONE_KEY = "swypik_onboarding_done";

function markDone() {
  try {
    sessionStorage.setItem(DONE_KEY, "1");
  } catch {
    /* ignore */
  }
}

export default function OnboardingGate() {
  const pathname = usePathname() ?? "";
  const onAuthPage = pathname.startsWith("/auth");
  const [creators, setCreators] = useState<SuggestedCreator[] | null>(null);

  useEffect(() => {
    if (onAuthPage || creators) return;
    try {
      if (sessionStorage.getItem(DONE_KEY) === "1") return;
    } catch {
      /* ignore */
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/me/onboarding", { credentials: "same-origin" });
        if (!res.ok) return; // 401 = anonim; poate se loghează mai târziu
        const data = (await res.json()) as { needed?: boolean };
        if (!data.needed) {
          markDone();
          return;
        }
        let list: SuggestedCreator[] = [];
        try {
          const sc = await fetch("/api/users/me/suggested-creators", { credentials: "same-origin" });
          if (sc.ok) {
            const body = (await sc.json()) as { creators?: SuggestedCreator[] };
            list = body.creators ?? [];
          }
        } catch {
          list = [];
        }
        if (!cancelled) setCreators(list);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onAuthPage, creators]);

  if (onAuthPage || !creators) return null;
  return <OnboardingModal initialCreators={creators} />;
}
