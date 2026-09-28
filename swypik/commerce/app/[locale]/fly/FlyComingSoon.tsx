"use client";

/**
 * Swypik Fly — „în curând / anunță-mă”. Singura acțiune: înscrierea în lista
 * de așteptare (POST /api/fly/waitlist). Fără zboruri sau prețuri afișate.
 */
import { useState, type FormEvent } from "react";
import { BellRing, CheckCircle2, Plane } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";

type Status = "idle" | "sending" | "done";

export default function FlyComingSoon() {
    const t = useTranslations("flyWaitlist");
    const locale = useLocale();
    const [email, setEmail] = useState("");
    const [destination, setDestination] = useState("");
    const [website, setWebsite] = useState("");
    const [status, setStatus] = useState<Status>("idle");
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setStatus("sending");
        setError(null);
        try {
            const res = await fetch("/api/fly/waitlist", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, destination: destination || undefined, locale, website }),
            });
            if (res.ok) {
                setStatus("done");
                return;
            }
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            setError(j.error === "rate_limited" ? t("errorRateLimited") : j.error === "invalid_input" ? t("errorInvalid") : t("errorGeneric"));
        } catch {
            setError(t("errorGeneric"));
        }
        setStatus("idle");
    };

    return (
        <div className="min-h-dvh bg-canvas">
            <PageHeader title={t("title")} />
            <main className="mx-auto max-w-lg space-y-4 px-gutter py-6">
                <Card variant="muted" padding="lg" className="text-center">
                    <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
                        <Plane className="h-8 w-8" aria-hidden />
                    </span>
                    <h1 className="text-xl font-bold text-fg">{t("heroTitle")}</h1>
                    <p className="mt-2 text-sm text-muted">{t("heroBody")}</p>
                </Card>

                {status === "done" ? (
                    <Card padding="lg" className="text-center" role="status">
                        <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-success" aria-hidden />
                        <p className="text-base font-semibold text-fg">{t("successTitle")}</p>
                        <p className="mt-1 text-sm text-muted">{t("successBody")}</p>
                    </Card>
                ) : (
                    <Card padding="lg">
                        <form onSubmit={submit} className="space-y-4" noValidate>
                            <TextField
                                label={t("emailLabel")}
                                type="email"
                                inputMode="email"
                                autoComplete="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder={t("emailPlaceholder")}
                                error={error ?? undefined}
                            />
                            <TextField
                                label={t("destinationLabel")}
                                hint={t("destinationHint")}
                                value={destination}
                                maxLength={80}
                                onChange={(e) => setDestination(e.target.value)}
                                placeholder={t("destinationPlaceholder")}
                            />
                            {/* Câmp-capcană pentru boți — ascuns vizual și pentru cititoare de ecran. */}
                            <input
                                type="text"
                                tabIndex={-1}
                                autoComplete="off"
                                aria-hidden
                                className="hidden"
                                value={website}
                                onChange={(e) => setWebsite(e.target.value)}
                                name="website"
                            />
                            <Button type="submit" block size="lg" loading={status === "sending"} disabled={!email}>
                                <BellRing className="h-4 w-4" aria-hidden />
                                {t("submit")}
                            </Button>
                            <p className="text-center text-xs text-subtle">{t("privacyNote")}</p>
                        </form>
                    </Card>
                )}
            </main>
        </div>
    );
}
