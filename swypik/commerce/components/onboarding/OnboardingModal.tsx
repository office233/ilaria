"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, BadgeCheck, ShoppingBag, Video, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { TOPICS } from "@/lib/topics";

export type SuggestedCreator = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number;
  isVerified: boolean;
};

type Props = {
  initialCreators: SuggestedCreator[];
};

// Cold start (2026-08-14): fara interese explicite, feed-ul unui user nou nu
// are niciun semnal de personalizare (taste vector pgvector e gol pana strange
// istoric). 3-7 interese la onboarding populeaza `user_interests` (weight 2.0,
// source 'onboarding') si dau boost imediat in ranking.
const MIN_INTERESTS = 3;
const MAX_INTERESTS = 7;

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export default function OnboardingModal({ initialCreators }: Props) {
  const t = useTranslations("onboardingModal");
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [creators] = useState<SuggestedCreator[]>(initialCreators);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [interests, setInterests] = useState<Set<string>>(new Set());
  const [savingInterests, setSavingInterests] = useState(false);
  const [interestsError, setInterestsError] = useState("");

  const completeOnboarding = useCallback(async () => {
    try {
      await fetch("/api/users/me/onboarding/complete", { method: "POST" });
    } catch {
      /* ignore */
    }
  }, []);

  const handleClose = useCallback(async () => {
    const ok = window.confirm(t("confirmSkip"));
    if (!ok) return;
    setOpen(false);
    await completeOnboarding();
  }, [completeOnboarding, t]);

  const toggleInterest = useCallback((id: string) => {
    setInterestsError("");
    setInterests((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_INTERESTS) next.add(id);
      return next;
    });
  }, []);

  const saveInterests = useCallback(async () => {
    if (interests.size < MIN_INTERESTS) {
      setInterestsError(`Alege cel puțin ${MIN_INTERESTS} interese.`);
      return;
    }
    setSavingInterests(true);
    setInterestsError("");
    try {
      const res = await fetch("/api/onboarding/interests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: Array.from(interests) }),
      });
      if (!res.ok) throw new Error("save failed");
      setStep(3);
    } catch {
      // Nu blocam onboarding-ul daca salvarea esueaza — userul merge mai departe.
      setInterestsError("Nu am putut salva preferințele, dar poți continua.");
      setStep(3);
    } finally {
      setSavingInterests(false);
    }
  }, [interests]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") void handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const toggleFollow = async (id: string) => {
    if (pending.has(id)) return;
    const isFollowing = following.has(id);
    setPending((p) => new Set(p).add(id));
    setFollowing((f) => {
      const next = new Set(f);
      if (isFollowing) next.delete(id);
      else next.add(id);
      return next;
    });
    try {
      const res = await fetch(`/api/users/${id}/follow`, { method: "POST" });
      if (!res.ok) throw new Error("follow failed");
    } catch {
      setFollowing((f) => {
        const next = new Set(f);
        if (isFollowing) next.add(id);
        else next.delete(id);
        return next;
      });
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(id);
        return next;
      });
    }
  };

  const goToFeed = async () => {
    setOpen(false);
    void completeOnboarding();
    router.push("/explore");
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in"
    >
      <div className="relative w-full sm:max-w-md bg-white text-black rounded-t-3xl sm:rounded-3xl shadow-2xl animate-in slide-in-from-bottom-4 max-h-[92vh] overflow-hidden flex flex-col">
        <button
          type="button"
          onClick={() => void handleClose()}
          aria-label={t("inchide")}
          className="absolute top-3 right-3 p-2 rounded-full hover:bg-black/5 transition"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-1.5 px-5 pt-5">
          {[1, 2, 3, 4].map((s) => (
            <span
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${s <= step ? "bg-black" : "bg-black/15"}`}
            />
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-6">
          {step === 1 && (
            <div className="space-y-5 text-center">
              <h2 id="onboarding-title" className="text-2xl font-bold">

                {t("bunVenitPeSwypik")}
              </h2>
              <p className="text-sm text-black/70">

                {t("descoperaProdusePrinClipuri")}
              </p>
              <div className="grid grid-cols-3 gap-3 mt-6">
                <div className="flex flex-col items-center gap-2 p-3 rounded-2xl bg-black/5">
                  <Video className="w-7 h-7" />
                  <span className="text-xs font-medium">Video feed</span>
                </div>
                <div className="flex flex-col items-center gap-2 p-3 rounded-2xl bg-black/5">
                  <ShoppingBag className="w-7 h-7" />
                  <span className="text-xs font-medium">{t("productsLabel")}</span>
                </div>
                <div className="flex flex-col items-center gap-2 p-3 rounded-2xl bg-black/5">
                  <Sparkles className="w-7 h-7" />
                  <span className="text-xs font-medium">{t("rewardsLabel")}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setStep(2)}
                className="mt-6 w-full py-3 rounded-full bg-black text-white font-semibold hover:bg-black/85 transition"
              >
                Mai departe
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 id="onboarding-title" className="text-xl font-bold">
                Ce te interesează?
              </h2>
              <p className="text-sm text-black/60">
                Alege {MIN_INTERESTS}–{MAX_INTERESTS} subiecte ca să-ți construim feed-ul de la primul clip.
              </p>

              <div className="flex flex-wrap gap-2">
                {TOPICS.map((topic) => {
                  const active = interests.has(topic.id);
                  const full = !active && interests.size >= MAX_INTERESTS;
                  return (
                    <button
                      key={topic.id}
                      type="button"
                      onClick={() => toggleInterest(topic.id)}
                      disabled={full}
                      aria-pressed={active}
                      className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${active
                          ? "bg-black text-white border-black"
                          : full
                            ? "bg-white text-black/30 border-black/10 cursor-not-allowed"
                            : "bg-white text-black border-black/15 hover:border-black/40"
                        }`}
                    >
                      {topic.label}
                    </button>
                  );
                })}
              </div>

              {interestsError && (
                <p className="text-sm text-red-600" role="alert">
                  {interestsError}
                </p>
              )}

              <div className="flex items-center justify-between pt-2">
                <span className="text-sm text-black/60">
                  {interests.size}/{MAX_INTERESTS} alese
                </span>
                <button
                  type="button"
                  onClick={() => void saveInterests()}
                  disabled={savingInterests || interests.size < MIN_INTERESTS}
                  className="px-5 py-2.5 rounded-full bg-black text-white text-sm font-semibold hover:bg-black/85 transition disabled:opacity-40"
                >
                  {savingInterests ? "Se salvează…" : t("continua")}
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 id="onboarding-title" className="text-xl font-bold">

                {t("urmaresteCreatori")}
              </h2>
              <p className="text-sm text-black/60">

                {t("alegeCativaCreatoriCa")}
              </p>

              {creators.length === 0 ? (
                <p className="text-sm text-black/50 py-6 text-center">

                  {t("nuSuntSugestiiDisponibile")}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {creators.map((c) => {
                    const isFollowing = following.has(c.id);
                    const isPending = pending.has(c.id);
                    return (
                      <div
                        key={c.id}
                        className="flex flex-col items-center text-center p-3 rounded-2xl border border-black/10"
                      >
                        <div className="w-14 h-14 rounded-full overflow-hidden bg-black/10 mb-2">
                          {c.avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.avatarUrl} alt={c.username} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-base font-bold text-black/40">
                              {(c.displayName || c.username).slice(0, 1).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-sm font-semibold leading-tight truncate max-w-full">
                          <span className="truncate">@{c.username}</span>
                          {c.isVerified && <BadgeCheck className="w-3.5 h-3.5 text-blue-500 shrink-0" />}
                        </div>
                        {c.displayName && (
                          <span className="text-[11px] text-black/50 truncate max-w-full">
                            {c.displayName}
                          </span>
                        )}
                        <span className="text-[10px] text-black/40 mb-2">
                          {formatCount(c.followerCount)}  {t("urmaritori")}
                        </span>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => void toggleFollow(c.id)}
                          className={`mt-auto w-full px-3 py-1.5 rounded-full text-xs font-semibold transition ${isFollowing ? "bg-black/10 text-black" : "bg-black text-white hover:bg-black/85"
                            } disabled:opacity-50`}
                        >
                          {isFollowing ? "Urmărit" : "Urmărește"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-2">
                <span className="text-xs text-black/60">

                  {t("aiUrmarit")} {following.size} {following.size === 1 ? "creator" : "creatori"}
                </span>
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="px-5 py-2.5 rounded-full bg-black text-white text-sm font-semibold hover:bg-black/85 transition"
                >

                  {t("continua")}
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-5 text-center">
              <h2 id="onboarding-title" className="text-2xl font-bold">

                {t("incepeSaDescoperi")}
              </h2>
              <p className="text-sm text-black/70">

                {t("feedulTauEGata")}
              </p>
              <div className="py-6">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-black text-white">
                  <Sparkles className="w-10 h-10" />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void goToFeed()}
                className="w-full py-3 rounded-full bg-black text-white font-semibold hover:bg-black/85 transition"
              >

                {t("mergiLaFeed")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
