"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Brain, CheckCircle2, LogIn, Trophy, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import Link from "next/link";
import { cn } from "@/lib/ui/cn";

type Question = { id: string; category: string; difficulty: string; question: string; options: string[] };
type Round = { token: string; questions: Question[]; xpAvailableToday: boolean; language: string };
type Result = { correctCount: number; totalQuestions: number; earnedXp: number; dailyXpAlreadyClaimed: boolean; results: { questionId: string; correct: boolean; correctAnswer: string | null }[] };
type State =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "error" }
  | { status: "submitting" }
  | { status: "playing"; round: Round; index: number; answers: Record<string, string> }
  | { status: "done"; round: Round; answers: Record<string, string>; result: Result };

export default function TriviaTab({ loginHref, onXpChanged }: { loginHref: string; onXpChanged: () => void }) {
  const t = useTranslations("gaming");
  const locale = useLocale();
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetch(`/api/gaming/trivia?locale=${encodeURIComponent(locale)}`, { credentials: "same-origin" })
      .then(async (r) => {
        if (r.status === 401) return setState({ status: "guest" });
        const d = await r.json();
        if (!r.ok || !d.ok) return setState({ status: "error" });
        setState({ status: "playing", round: { token: d.roundToken, questions: d.questions ?? [], xpAvailableToday: Boolean(d.xpAvailableToday), language: String(d.language ?? "en") }, index: 0, answers: {} });
      })
      .catch(() => setState({ status: "error" }));
  }, [locale]);
  useEffect(load, [load]);

  const submit = async (round: Round, answers: Record<string, string>) => {
    setState({ status: "submitting" });
    try {
      const res = await fetch("/api/gaming/trivia/answer", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundToken: round.token, answers: round.questions.map((q) => ({ questionId: q.id, answer: answers[q.id] })) }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) return setState({ status: "error" });
      setState({ status: "done", round, answers, result: d as Result });
      if (d.earnedXp > 0) onXpChanged();
    } catch {
      setState({ status: "error" });
    }
  };

  const pick = (option: string) => {
    if (state.status !== "playing") return;
    const q = state.round.questions[state.index];
    const answers = { ...state.answers, [q.id]: option };
    if (state.index + 1 < state.round.questions.length) setState({ ...state, answers, index: state.index + 1 });
    else void submit(state.round, answers);
  };

  if (state.status === "loading" || state.status === "submitting") return <Skeleton className="h-72 w-full rounded-card" />;
  if (state.status === "error") return <ErrorState onRetry={load} />;
  if (state.status === "guest") {
    return (
      <EmptyState
        icon={LogIn}
        title={t("signIn.triviaTitle")}
        description={t("signIn.body")}
        action={<Button asChild><Link href={loginHref}>{t("signIn.cta")}</Link></Button>}
      />
    );
  }
  if (state.round.questions.length === 0) return <EmptyState icon={Brain} title={t("trivia.empty")} />;

  if (state.status === "done") {
    const { result, round, answers } = state;
    const byId = new Map(result.results.map((r) => [r.questionId, r]));
    return (
      <div className="space-y-3">
        <Card className="flex flex-col items-center gap-2 text-center">
          <Trophy className="h-10 w-10 text-warning" aria-hidden />
          <p className="text-lg font-semibold text-fg">{t("trivia.completeTitle")}</p>
          <p className="text-sm text-muted">{t("trivia.completeBody", { correct: result.correctCount, total: result.totalQuestions })}</p>
          <Badge tone={result.earnedXp > 0 ? "success" : "neutral"}>
            {result.earnedXp > 0 ? t("trivia.earned", { xp: result.earnedXp }) : t("trivia.noXp")}
          </Badge>
          <Button variant="secondary" onClick={load}>{t("trivia.practiceAgain")}</Button>
        </Card>
        <ul className="space-y-2">
          {round.questions.map((q) => {
            const r = byId.get(q.id);
            return (
              <li key={q.id}>
                <Card padding="sm" className="flex gap-2 text-sm">
                  {r?.correct ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label={t("trivia.correct")} /> : <XCircle className="h-5 w-5 shrink-0 text-danger" aria-label={t("trivia.wrong")} />}
                  <div className="min-w-0">
                    <p className="text-fg">{q.question}</p>
                    <p className="text-xs text-muted">{t("trivia.yourAnswer", { answer: answers[q.id] ?? "—" })}</p>
                    {!r?.correct && r?.correctAnswer && <p className="text-xs text-success">{t("trivia.correctAnswer", { answer: r.correctAnswer })}</p>}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const { round, index } = state;
  const q = round.questions[index];
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span>{t("trivia.questionOf", { current: index + 1, total: round.questions.length })}</span>
        <Badge tone={round.xpAvailableToday ? "brand" : "neutral"}>{round.xpAvailableToday ? t("trivia.xpAvailable") : t("trivia.practice")}</Badge>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-brand transition-[width] duration-base" style={{ width: `${((index + 1) / round.questions.length) * 100}%` }} />
      </div>
      {round.language !== locale ? <p className="text-xs text-muted">{t("trivia.englishOnly")}</p> : null}
      <p className="text-xs text-subtle">{q.category}</p>
      <h3 className="text-lg font-semibold text-fg">{q.question}</h3>
      <div className="space-y-2">
        {q.options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => pick(option)}
            className={cn(
              "flex min-h-11 w-full items-center rounded-control border border-subtle bg-surface px-4 py-3 text-left text-sm font-medium text-fg transition-colors duration-fast hover:bg-surface-2",
              state.answers[q.id] === option && "border-brand bg-brand-soft text-brand-soft-fg",
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </Card>
  );
}
