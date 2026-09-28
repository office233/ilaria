"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter as useNextRouter } from "next/navigation";
import { Link, useRouter } from "@/lib/i18n/navigation";
import { isNonLocalizedPath } from "@/lib/i18n/non-localized";
import Image from "next/image";
import { Settings, Plus, Video, Heart, Package, Grid, Bookmark, Trophy, Coins, ChevronRight, Compass, User, MoreVertical, Trash2, Eye, EyeOff } from "lucide-react";
import PushNotificationCard from "@/components/push/PushNotificationCard";
import MyModes from "@/components/account/MyModes";
import { useLocale, useTranslations } from "next-intl";
import { SUPPORT_EMAIL } from "@/lib/contact";
import { VideoGrid } from "@/components/social/profile/VideoGrid";
import { AccountSocialSummary } from "@/components/account/AccountSocialSummary";

type AccountPageClientProps = {
  redirectTo: string;
};

export default function AccountPageClient({ redirectTo }: AccountPageClientProps) {
  const t = useTranslations("account");
  const ta = useTranslations("authEmail.account");
  const locale = useLocale();
  const ts = useTranslations("social.profile");
  const [view, setView] = useState<"loading" | "login" | "verify" | "twofa" | "account">("loading");
  const [twoFaToken, setTwoFaToken] = useState<string | null>(null);
  const [twoFaCode, setTwoFaCode] = useState("");
  const [customer, setCustomer] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [videos, setVideos] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"videos" | "orders" | "saved">("videos");
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [challengesCount, setChallengesCount] = useState<number | null>(null);
  const [videoMenu, setVideoMenu] = useState<string | null>(null);
  const [videoBusy, setVideoBusy] = useState<string | null>(null);

  // Opțiuni pe clip (proprietar): ștergere + comutare vizibilitate.
  const deleteVideo = useCallback(async (videoId: string) => {
    if (!window.confirm(t("confirmDeleteVideo"))) return;
    setVideoBusy(videoId);
    try {
      const res = await fetch(`/api/creator/videos/${videoId}`, { method: "DELETE" });
      if (res.ok) {
        setVideos((prev) => prev.filter((v) => v.id !== videoId));
      } else {
        window.alert(t("deleteVideoFailed"));
      }
    } catch {
      window.alert(t("networkErrorRetry"));
    } finally {
      setVideoBusy(null);
      setVideoMenu(null);
    }
  }, [t]);

  const toggleVisibility = useCallback(async (videoId: string, current: string) => {
    const next = current === "public" ? "private" : "public";
    setVideoBusy(videoId);
    try {
      const res = await fetch(`/api/creator/videos/${videoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish: next }),
      });
      if (res.ok) {
        setVideos((prev) => prev.map((v) => (v.id === videoId ? { ...v, visibility: next } : v)));
      } else {
        window.alert(t("visibilityChangeFailed"));
      }
    } catch {
      window.alert(t("networkErrorRetry"));
    } finally {
      setVideoBusy(null);
      setVideoMenu(null);
    }
  }, [t]);

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  const router = useRouter();
  const nextRouter = useNextRouter();
  // `redirectTo` poate ținti o rută non-localizată (/creator, /seller): acolo
  // navigăm fără prefix de limbă; restul trec prin routerul localizat.
  const goToRedirect = useCallback(
    (href: string) => (isNonLocalizedPath(href) ? nextRouter.push(href) : router.push(href)),
    [nextRouter, router],
  );

  const loadData = useCallback(async () => {
    try {
      // Load orders
      const resOrders = await fetch("/api/auth/orders");
      const dataOrders = await resOrders.json();
      if (dataOrders.success) setOrders(dataOrders.orders);

      // Load creator videos (if endpoint exists, else fallback to empty)
      try {
        const resVideos = await fetch("/api/creator/videos");
        if (resVideos.ok) {
          const dataVideos = await resVideos.json();
          if (dataVideos.videos) setVideos(dataVideos.videos);
        }
      } catch (e) {
        console.error("No videos found", e);
      }

    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          setCustomer(data.customer);
          setView("account");
          void loadData();
          if (redirectTo !== "/") {
            goToRedirect(redirectTo);
          }
        } else {
          setView("login");
        }
      })
      .catch(() => setView("login"));
  }, [loadData, redirectTo, goToRedirect]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    setDevOtp(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", email, locale }),
      });
      const data = await res.json();
      if (data.requiresVerification) {
        if (data.devOtp) setDevOtp(data.devOtp);
        setView("verify");
      } else {
        setLoginError(data.error || ta("loginFailed"));
      }
    } catch {
      setLoginError(ta("connection"));
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify_otp", email, token: otp }),
      });
      const data = await res.json();
      if (data.success && data.requires2FA && data.tempToken) {
        setTwoFaToken(data.tempToken);
        setView("twofa");
      } else if (data.success) {
        const meRes = await fetch("/api/auth");
        const meData = await meRes.json();
        if (meData.authenticated) {
          setCustomer(meData.customer);
          setView("account");
          void loadData();
        }
        if (redirectTo !== "/") goToRedirect(redirectTo);
      } else {
        setLoginError(data.error || ta("codeInvalid"));
      }
    } catch {
      setLoginError(ta("connection"));
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleTwoFa(e: React.FormEvent) {
    e.preventDefault();
    if (!twoFaToken) return;
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify_2fa", tempToken: twoFaToken, code: twoFaCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setLoginError(data.error || ta("codeInvalid"));
        return;
      }
      window.location.assign(redirectTo !== "/" ? redirectTo : "/account");
    } catch {
      setLoginError(ta("connection"));
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth", { method: "DELETE" });
    setCustomer(null);
    setOrders([]);
    setVideos([]);
    setView("login");
    router.push("/");
  }

  /* ════════════════════ LOADING ════════════════════ */
  if (view === "loading") {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-white/10 border-t-brand rounded-full animate-spin" />
      </div>
    );
  }

  /* ════════════════════ LOGIN ════════════════════ */
  if (view === "login") {
    return (
      <div className="min-h-screen bg-[#0D0D0D] text-white">
        <div className="max-w-sm mx-auto px-6 pt-24">
          <div className="text-center mb-10">
            <h1 className="text-4xl font-black mb-2">{ta("loginTitle")}</h1>
            <p className="text-white/60">{t("introduEmailulPentruA")}</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("emailulTau")}
              autoFocus
              required
              className="w-full rounded-2xl bg-white/5 border border-white/10 px-5 py-4 text-white placeholder-white/40 outline-none focus:border-brand transition"
            />
            {loginError && <p className="text-sm font-bold text-danger">{loginError}</p>}
            <button
              type="submit"
              disabled={loginLoading || !email.trim()}
              className="w-full rounded-2xl bg-brand hover:bg-brand-hover py-4 font-black text-white disabled:opacity-50 transition active:scale-95"
            >
              {loginLoading ? t("loadingEllipsis") : t("continue")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ════════════════════ 2FA (după codul pe email) ════════════════════ */
  if (view === "twofa") {
    return (
      <div data-theme="dark" className="min-h-screen bg-canvas text-white">
        <div className="max-w-sm mx-auto px-6 pt-24">
          <div className="text-center mb-10">
            <h1 className="text-3xl font-black mb-2">{ta("twoFactorTitle")}</h1>
            <p className="text-white/60">{ta("twoFactorIntro")}</p>
          </div>
          <form onSubmit={handleTwoFa} className="space-y-4">
            <input
              type="text"
              value={twoFaCode}
              onChange={(e) => setTwoFaCode(e.target.value.trim().slice(0, 8))}
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={8}
              aria-label={ta("twoFactorTitle")}
              className="w-full text-center tracking-[0.3em] text-2xl rounded-2xl bg-white/5 border border-white/10 px-4 py-4 font-black text-white outline-none focus:border-brand transition"
            />
            {loginError && <p role="alert" className="text-sm font-bold text-danger text-center">{loginError}</p>}
            <button
              type="submit"
              disabled={loginLoading || twoFaCode.length < 6}
              className="w-full rounded-2xl bg-brand hover:bg-brand-hover py-4 font-black text-brand-fg disabled:opacity-50 transition active:scale-95"
            >
              {loginLoading ? t("verifyingEllipsis") : t("confirmAccess")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ════════════════════ VERIFY OTP ════════════════════ */
  if (view === "verify") {
    return (
      <div className="min-h-screen bg-[#0D0D0D] text-white">
        <div className="max-w-sm mx-auto px-6 pt-24">
          <div className="text-center mb-10">
            <h1 className="text-4xl font-black mb-2">{t("verification")}</h1>
            <p className="text-white/60">{t("codulAFostTrimis")} <br /><b className="text-white">{email}</b></p>
          </div>

          {devOtp && (
            <div className="mb-8 rounded-2xl border border-[#0D0D0D]/30 bg-[#0D0D0D]/10 p-6 text-center">
              <p className="text-xs font-bold text-[#0D0D0D] uppercase tracking-widest mb-2">{t("codDeTest")}</p>
              <p className="text-4xl font-black text-white tracking-[0.3em] font-mono">{devOtp}</p>
            </div>
          )}

          <form onSubmit={handleVerify} className="space-y-4">
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              autoFocus
              required
              inputMode="numeric"
              maxLength={6}
              className="w-full text-center tracking-[0.5em] text-3xl rounded-2xl bg-white/5 border border-white/10 px-4 py-4 font-black text-white outline-none focus:border-brand transition"
            />
            {loginError && <p className="text-sm font-bold text-danger text-center">{loginError}</p>}
            <button
              type="submit"
              disabled={loginLoading || otp.length < 6}
              className="w-full rounded-2xl bg-brand hover:bg-brand-hover py-4 font-black text-white disabled:opacity-50 transition active:scale-95"
            >
              {loginLoading ? t("verifyingEllipsis") : t("confirmAccess")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ════════════════════ TIKTOK STYLE PROFILE ════════════════════ */
  return (
    <div className="min-h-screen bg-[#0D0D0D] text-white mobile-page-bottom">
      {/* Top Navbar (NU mai e sticky — header se suprapunea peste avatar la scroll) */}
      <header className="relative z-10 bg-[#0D0D0D] border-b border-white/10 px-4 py-4 flex items-center justify-between">
        <div className="w-11" aria-hidden="true" />
        <h1 className="text-lg font-black">{customer?.username || t("profileFallback")}</h1>
        <Link
          href="/account/settings"
          className="grid h-11 w-11 place-items-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
          aria-label={t("setari")}
        >
          <Settings size={22} />
        </Link>
      </header>

      <div className="max-w-md mx-auto px-4 pt-6">
        <PushNotificationCard />
        {/* Profile Info */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-brand to-accent p-1 mb-4">
            <div className="w-full h-full rounded-full bg-[#1A1A1A] flex items-center justify-center overflow-hidden border-2 border-[#0D0D0D]">
              {customer?.avatar_url ? (
                <Image src={customer.avatar_url} alt={t("avatarAlt")} width={96} height={96} className="w-full h-full object-cover" unoptimized />
              ) : (
                <User size={32} />
              )}
            </div>
          </div>
          <h2 className="text-xl font-black">{customer?.display_name || t("defaultCreatorName")}</h2>
          <p className="text-sm text-white/60 mb-1">@{customer?.username || "user"}</p>
          <AccountSocialSummary username={customer?.username ?? null} />

          <div className="flex gap-3 w-full">
            <Link
              href="/upload"
              className="flex-1 bg-brand hover:bg-brand-hover text-white py-3 min-h-[44px] rounded-lg font-bold flex items-center justify-center gap-2 transition focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"
            >
              <Plus size={18} />  {t("publica")}
            </Link>
            <Link href="/account/edit" className="flex-1 bg-white/10 hover:bg-white/20 text-white py-3 min-h-[44px] flex items-center justify-center rounded-lg font-bold text-center transition focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none">

              {t("editeaza")}
            </Link>
          </div>
        </div>

        {/* Modurile mele — comutare rol (cumpărător/creator/seller/curier) */}
        <MyModes />

        {/* Descoperă */}
        <section aria-label={t("descopera")} className="mb-6">
          <div className="flex items-center justify-between mb-3 px-1">
            <h3 className="text-sm font-black uppercase tracking-wider text-white/70">{t("descopera2")}</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/explore"
              className="group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#10A37F]/20 via-[#1A1A1A] to-[#1A1A1A] p-4 hover:border-[#10A37F]/60 transition active:scale-[0.98]"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="w-9 h-9 rounded-xl bg-[#10A37F]/20 flex items-center justify-center">
                  <Compass size={18} className="text-[#10A37F]" aria-hidden />
                </div>
                <ChevronRight size={16} className="text-white/40 group-hover:text-white/80 transition" aria-hidden />
              </div>
              <p className="text-[11px] uppercase font-bold tracking-wider text-white/50">{t("cardExploreKicker")}</p>
              <p className="mt-1 text-xl font-black text-white">{t("cardExploreTitle")}</p>
              <p className="mt-1 text-xs text-[#10A37F] font-bold">{t("cardExploreCta")}</p>
            </Link>

            <Link
              href="/missions"
              className="group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#F59E0B]/20 via-[#1A1A1A] to-[#1A1A1A] p-4 hover:border-[#F59E0B]/60 transition active:scale-[0.98]"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="w-9 h-9 rounded-xl bg-[#F59E0B]/20 flex items-center justify-center">
                  <Trophy size={18} className="text-[#F59E0B]" aria-hidden />
                </div>
                <ChevronRight size={16} className="text-white/40 group-hover:text-white/80 transition" aria-hidden />
              </div>
              <p className="text-[11px] uppercase font-bold tracking-wider text-white/50">{t("cardMissionsKicker")}</p>
              <p className="mt-1 text-xl font-black text-white">{t("cardMissionsTitle")}</p>
              <p className="mt-1 text-xs text-[#F59E0B] font-bold">{t("cardMissionsCta")}</p>
            </Link>
          </div>
        </section>

        {/* Tabs */}
        <div className="flex border-b border-white/10 mb-1">
          <button
            onClick={() => setActiveTab("videos")}
            className={`flex-1 py-3 min-h-[44px] flex items-center justify-center gap-1 border-b-2 text-xs font-bold transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 focus-visible:outline-none ${activeTab === "videos" ? "border-white text-white" : "border-transparent text-white/50"}`}
          >
            <Grid size={18} />
            <span>{ts("tabVideos")}</span>
          </button>
          <button
            onClick={() => setActiveTab("saved")}
            className={`flex-1 py-3 min-h-[44px] flex items-center justify-center gap-1 border-b-2 text-xs font-bold transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 focus-visible:outline-none ${activeTab === "saved" ? "border-white text-white" : "border-transparent text-white/50"}`}
          >
            <Bookmark size={18} />
            <span>{ts("tabSaved")}</span>
          </button>
          <Link
            href="/account/liked"
            className="flex-1 py-3 min-h-[44px] flex items-center justify-center gap-1 border-b-2 border-transparent text-xs font-bold text-white/50 transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 focus-visible:outline-none"
          >
            <Heart size={18} />
            <span>{ts("tabLiked")}</span>
          </Link>
          <button
            onClick={() => setActiveTab("orders")}
            className={`flex-1 py-3 min-h-[44px] flex items-center justify-center gap-1 border-b-2 text-xs font-bold transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 focus-visible:outline-none ${activeTab === "orders" ? "border-white text-white" : "border-transparent text-white/50"}`}
          >
            <Package size={18} />
            <span>{ts("tabOrders")}</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="min-h-[300px]">
          {activeTab === "videos" && (
            <div className="grid grid-cols-2 gap-0.5 sm:grid-cols-3">
              {videos.length === 0 ? (
                <div className="col-span-3 py-20 text-center text-white/40">
                  <Video size={32} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{t("nuAiPublicatInca")}</p>
                </div>
              ) : (
                videos.map((vid, i) => {
                  // BUG 4 (2026-08-03): proprietarul vede badge de stare pentru
                  // clipurile neprocesate; doar clipurile ready sunt clickabile.
                  const isReady = vid.status === "ready";
                  const isFailed = vid.status === "failed";
                  const inner = (
                    <>
                      {vid.thumbnail_url && (
                        <Image src={vid.thumbnail_url} className={`w-full h-full object-cover ${!isReady ? "opacity-40" : ""}`} alt={t("videoAlt")} fill sizes="(max-width: 640px) 50vw, 33vw" unoptimized />
                      )}
                      {!isReady && (
                        <span className={`absolute top-1.5 left-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${isFailed ? "bg-red-500/90 text-white" : "bg-amber-500/90 text-black"}`}>
                          {isFailed ? t("clipEsuat") : t("clipInProcesare")}
                        </span>
                      )}
                      <div className="absolute bottom-1 left-2 flex items-center gap-1 text-[10px] font-bold">
                        <Heart size={10} /> {vid.like_count ?? vid.likes_count ?? 0}
                      </div>
                    </>
                  );
                  return isReady ? (
                    <div key={vid.id || i} className="aspect-[9/16] bg-white/5 relative group">
                      <Link href={`/explore?v=${vid.id}`} className="absolute inset-0 cursor-pointer block">
                        {inner}
                      </Link>
                      {/* Meniu opțiuni proprietar (ca pe TikTok/IG) */}
                      <button
                        aria-label={t("videoOptions")}
                        onClick={(e) => { e.preventDefault(); setVideoMenu(videoMenu === vid.id ? null : vid.id); }}
                        className="absolute top-1 right-1 z-10 rounded-full bg-black/60 p-1.5 text-white opacity-80 hover:opacity-100"
                      >
                        <MoreVertical size={14} />
                      </button>
                      {videoMenu === vid.id && (
                        <div className="absolute top-8 right-1 z-20 w-44 rounded-xl border border-white/10 bg-[#1A1A1A] py-1 shadow-xl">
                          <button
                            disabled={videoBusy === vid.id}
                            onClick={() => toggleVisibility(vid.id, vid.visibility)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-white hover:bg-white/10 disabled:opacity-40"
                          >
                            {vid.visibility === "public" ? <EyeOff size={13} /> : <Eye size={13} />}
                            {vid.visibility === "public" ? t("makePrivate") : t("makePublic")}
                          </button>
                          <button
                            disabled={videoBusy === vid.id}
                            onClick={() => deleteVideo(vid.id)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                          >
                            <Trash2 size={13} />
                            {t("deleteVideo")}
                          </button>
                        </div>
                      )}
                      {vid.visibility === "private" && (
                        <span className="absolute bottom-1 right-1 z-10 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-white/80">{t("private")}</span>
                      )}
                    </div>
                  ) : (
                    <div key={vid.id || i} className="aspect-[9/16] bg-white/5 relative">
                      {inner}
                      {/* Clipurile eșuate/în procesare pot fi șterse direct */}
                      <button
                        aria-label={t("deleteVideo")}
                        disabled={videoBusy === vid.id}
                        onClick={() => deleteVideo(vid.id)}
                        className="absolute top-1 right-1 z-10 rounded-full bg-black/60 p-1.5 text-red-400 opacity-80 hover:opacity-100 disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Pagina de cont e (încă) mereu închisă la culoare: tokenii grilei în varianta dark. */}
          {activeTab === "saved" && (
            <div className="py-2" data-theme="dark">
              {customer?.username ? (
                <VideoGrid username={customer.username} tab="saved" initial={null} emptyTitle={ts("emptySavedVideos")} />
              ) : null}
              <Link
                href="/account/saved"
                className="mt-3 flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white/10 text-sm font-bold text-white hover:bg-white/15"
              >
                <Bookmark size={16} aria-hidden />
                {ts("savedProducts")}
              </Link>
            </div>
          )}

          {activeTab === "orders" && (
            <div className="py-4 space-y-3">
              {orders.length === 0 ? (
                <div className="text-center py-10 text-white/40">
                  <Package size={32} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{t("nuAiNicioComanda")}</p>
                </div>
              ) : (
                orders.map((order, i) => (
                  <div key={i} className="bg-white/5 rounded-xl p-4 flex items-center justify-between">
                    <div>
                      <p className="font-bold text-sm">{t("comanda")}{order.id.split("-")[0]}</p>
                      <p className="text-xs text-white/50">{order.status}</p>
                    </div>
                    <p className="font-black text-[#0D0D0D]">{order.totalRon} lei</p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Linkuri legale — aplicația nu are footer de site; profilul e
            locul standard în aplicații mobile (vezi Revolut, Uber). */}
        <div className="mt-8 border-t border-black/5 pt-4 pb-6">
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-[12px] font-semibold text-[#6E6E80]">
            <a href="/terms" className="underline-offset-2 hover:underline">{t("legalTerms" as never)}</a>
            <a href="/privacy" className="underline-offset-2 hover:underline">{t("legalPrivacy" as never)}</a>
            <a href="/legal/cookies" className="underline-offset-2 hover:underline">{t("legalCookies" as never)}</a>
            <a href="/legal/anpc" className="underline-offset-2 hover:underline">ANPC</a>
            <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">SOL (UE)</a>
          </div>
          <p className="mt-2 text-[11px] text-[#C4C4CC]">© {new Date().getFullYear()} Swypik Technology · {SUPPORT_EMAIL}</p>
        </div>

      </div>
    </div>
  );
}
