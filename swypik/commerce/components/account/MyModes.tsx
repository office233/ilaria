"use client";

/**
 * „Modurile mele” — comutare rapidă între rolurile disponibile ale userului
 * (cumpărător / creator / vânzător / curier-șofer). Doar UI + link-uri: nu
 * modifică modelul de date, doar citește /api/auth/me și /api/couriers.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronRight, Home, Video, Store, Bike, BedDouble, Building2 } from "lucide-react";

type Me = {
  role?: string | null;
  sellerId?: string | null;
};

type CourierProfile = {
  kind?: string | null;
  verification_status?: "pending" | "approved" | "rejected" | string | null;
};

type Mode = {
  href: string;
  icon: typeof Home;
  title: string;
  sub: string;
  badge?: string;
  badgeTone?: "ok" | "warn" | "bad";
};

export default function MyModes() {
  const t = useTranslations("shell");
  const [me, setMe] = useState<Me | null>(null);
  const [courier, setCourier] = useState<CourierProfile | null>(null);
  const [hostApp, setHostApp] = useState<{ status: string; property_name: string } | null>(null);
  const [franchise, setFranchise] = useState<{ status: string; company_name: string; city: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [resMe, resCourier, resHost, resFranchise] = await Promise.all([
          fetch("/api/auth/me").catch(() => null),
          fetch("/api/couriers").catch(() => null),
          fetch("/api/hosts/apply").catch(() => null),
          fetch("/api/fleet-partners").catch(() => null),
        ]);
        if (cancelled) return;
        if (resMe?.ok) {
          const d = await resMe.json();
          setMe(d?.user ?? null);
        }
        if (resCourier?.ok) {
          const d = await resCourier.json();
          setCourier(d?.courier ?? null);
        }
        if (resHost?.ok) {
          const d = await resHost.json();
          setHostApp(d?.applications?.[0] ?? null);
        }
        if (resFranchise?.ok) {
          const d = await resFranchise.json();
          setFranchise(d?.partner ?? null);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) return null;

  const modes: Mode[] = [
    { href: "/", icon: Home, title: t("modeBuyer"), sub: t("modeBuyerSub") },
  ];

  if (me?.role === "creator" || me?.role === "seller" || me?.role === "admin") {
    modes.push({ href: "/upload", icon: Video, title: t("modeCreator"), sub: t("modeCreatorSub") });
  }
  if (me?.sellerId) {
    modes.push({ href: "/seller", icon: Store, title: t("modeSeller"), sub: t("modeSellerSub") });
  }
  if (courier) {
    const status = courier.verification_status ?? "pending";
    modes.push({
      href: "/courier",
      icon: Bike,
      title: t("modeCourier"),
      sub: t("modeCourierSub"),
      badge:
        status === "approved" ? t("courierApproved") : status === "rejected" ? t("courierRejected") : t("courierPending"),
      badgeTone: status === "approved" ? "ok" : status === "rejected" ? "bad" : "warn",
    });
  }
  if (hostApp) {
    const s = hostApp.status;
    modes.push({
      href: s === "approved" ? "/stays/manage" : "/join/host",
      icon: BedDouble,
      title: "Gazdă Stays",
      sub: hostApp.property_name,
      badge: s === "approved" ? "Aprobat" : s === "rejected" ? "Respins" : s === "needs_info" ? "Documente" : "În verificare",
      badgeTone: s === "approved" ? "ok" : s === "rejected" ? "bad" : "warn",
    });
  }
  if (franchise) {
    const s = franchise.status;
    modes.push({
      href: "/fleet",
      icon: Building2,
      title: "Franciză de flotă",
      sub: `${franchise.company_name} · ${franchise.city}`,
      badge: s === "active" ? "Activă" : s === "rejected" ? "Respinsă" : s === "suspended" ? "Suspendată" : "În verificare",
      badgeTone: s === "active" ? "ok" : s === "rejected" || s === "suspended" ? "bad" : "warn",
    });
  }
  const hasAnyPartnerMode = Boolean(me?.sellerId) || Boolean(courier) || Boolean(hostApp) || Boolean(franchise);

  const toneClass = (tone?: Mode["badgeTone"]) =>
    tone === "ok"
      ? "bg-[#10A37F]/20 text-[#10A37F]"
      : tone === "bad"
        ? "bg-[#E0264A]/20 text-[#E0264A]"
        : "bg-[#F59E0B]/20 text-[#F59E0B]";

  return (
    <section aria-label={t("myModes")} className="mb-6">
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-sm font-black uppercase tracking-wider text-white/70">{t("myModes")}</h3>
      </div>
      <ul className="space-y-2">
        {modes.map((m) => {
          const Icon = m.icon;
          return (
            <li key={`${m.href}-${m.title}`}>
              <Link
                href={m.href}
                className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-[#1A1A1A] p-3 transition hover:border-white/30 active:scale-[0.98] min-h-[56px]"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10">
                  <Icon size={18} className="text-white" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-black text-white">{m.title}</span>
                  <span className="block truncate text-xs text-white/50">{m.sub}</span>
                </span>
                {m.badge && (
                  <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${toneClass(m.badgeTone)}`}>
                    {m.badge}
                  </span>
                )}
                <ChevronRight size={16} className="text-white/40 group-hover:text-white/80 transition" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
      {/* Mereu vizibil: cine e deja seller poate deveni și gazdă/curier. */}
      <Link
        href="/join"
        className="mt-3 flex items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 py-3 text-sm font-black text-white/70 transition hover:border-white/40 hover:text-white"
      >
        + {hasAnyPartnerMode ? "Adaugă alt mod partener" : t("becomePartner")}
      </Link>
    </section>
  );
}
