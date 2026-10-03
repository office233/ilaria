/**
 * Jurnal de consum Azure AI (tokeni / secunde audio / apeluri de moderare).
 * Un singur eveniment structurat per apel → agregabil din loguri (Loki/Sentry)
 * pe `op`, `feature` și `deployment`, fără tabel nou.
 */
import { logger } from "@/lib/logger";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function parseUsage(raw: unknown): TokenUsage {
  const u = (raw && typeof raw === "object" ? raw : {}) as RawUsage;
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
    totalTokens: num(u.total_tokens) || promptTokens + completionTokens,
  };
}

export function logUsage(entry: {
  op: string;
  feature: string;
  deployment?: string;
  ms: number;
  ok: boolean;
  usage?: TokenUsage;
  audioSeconds?: number;
  errorCode?: string;
}): void {
  logger.info({ component: "azure-ai", ai_usage: entry }, "[azure-ai] usage");
}
