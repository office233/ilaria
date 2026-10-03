import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import roBank from "./trivia-bank/ro.json";

export interface TriviaQuestion {
  id: string;
  category: string;
  difficulty: string;
  question: string;
  options: string[];
  correctAnswer: string;
}

/** Entitățile HTML pe care OpenTDB le trimite (numerice + cele cu nume uzuale). */
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: "\u00a0",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026",
  ndash: "\u2013", mdash: "\u2014", deg: "\u00b0", shy: "", reg: "\u00ae", trade: "\u2122", copy: "\u00a9",
  eacute: "é", Eacute: "É", egrave: "è", ecirc: "ê", euml: "ë", aacute: "á", agrave: "à", acirc: "â",
  auml: "ä", Auml: "Ä", aring: "å", atilde: "ã", ccedil: "ç", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ", oacute: "ó", ocirc: "ô", ouml: "ö", Ouml: "Ö", otilde: "õ", oslash: "ø", uacute: "ú",
  ucirc: "û", uuml: "ü", Uuml: "Ü", szlig: "ß", pi: "π", micro: "µ", times: "×", divide: "÷",
};

export function decodeHTMLEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent] ?? m;
  });
}

type BankQuestion = Omit<TriviaQuestion, "id">;

/** Limbile cu bancă proprie de întrebări; restul primesc OpenTDB (engleză) + mențiune în UI. */
const LOCAL_BANKS: Record<string, BankQuestion[]> = { ro: roBank as BankQuestion[] };
const QUESTIONS_PER_ROUND = 5;

export function triviaLanguage(locale: string | null | undefined): "ro" | "en" {
  return locale && locale in LOCAL_BANKS ? (locale as "ro") : "en";
}

/** 5 întrebări pe zi din banca locală, rotite determinist după dată, cu opțiunile amestecate. */
function localRound(locale: string, day: string): TriviaQuestion[] {
  const bank = LOCAL_BANKS[locale];
  const dayIndex = Math.floor(Date.parse(day) / 86_400_000);
  const start = (dayIndex * QUESTIONS_PER_ROUND) % bank.length;
  return Array.from({ length: Math.min(QUESTIONS_PER_ROUND, bank.length) }, (_, i) => {
    const q = bank[(start + i) % bank.length];
    return { ...q, id: `q_${locale}_${(start + i) % bank.length}`, options: [...q.options].sort(() => Math.random() - 0.5) };
  });
}

const FALLBACK_QUESTIONS: TriviaQuestion[] = [
  {
    id: "q_fallback_1",
    category: "Video Games",
    difficulty: "easy",
    question: "What is the best-selling video game of all time?",
    options: ["Minecraft", "Tetris", "Grand Theft Auto V", "Super Mario Bros"],
    correctAnswer: "Minecraft",
  },
  {
    id: "q_fallback_2",
    category: "Video Games",
    difficulty: "medium",
    question: "In what year was the first PlayStation console released by Sony?",
    options: ["1994", "1996", "1992", "1998"],
    correctAnswer: "1994",
  },
  {
    id: "q_fallback_3",
    category: "Video Games",
    difficulty: "easy",
    question: "Who is the green-capped hero of the Legend of Zelda series?",
    options: ["Link", "Zelda", "Ganon", "Luigi"],
    correctAnswer: "Link",
  },
];

/**
 * Daily trivia question pool, cached per-day. Includes correctAnswer — this
 * is server-side only; callers MUST strip it before sending to the client
 * (see app/api/gaming/trivia/route.ts, which builds a signed round token
 * instead of trusting the client with answers).
 */
export async function getDailyTriviaQuestions(locale?: string | null): Promise<TriviaQuestion[]> {
  const day = new Date().toISOString().slice(0, 10);
  if (triviaLanguage(locale) !== "en") return localRound(triviaLanguage(locale), day);
  const todayKey = `gaming:trivia:cache:${day}`;

  try {
    const redis = getRedis();
    if (redis) {
      const cached = await redis.get(todayKey);
      if (cached) {
        return typeof cached === "string" ? JSON.parse(cached) : cached;
      }
    }
  } catch (e) {
    logger.debug({ err: e }, "[gaming.trivia] redis cache read failed, continuing");
  }

  try {
    const res = await fetch("https://opentdb.com/api.php?amount=5&category=15&type=multiple", {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`opentdb status ${res.status}`);
    const data = await res.json();

    if (data.response_code === 0 && Array.isArray(data.results)) {
      type OpenTdbResult = { category: string; difficulty: string; question: string; correct_answer: string; incorrect_answers: string[] };
      const questions: TriviaQuestion[] = (data.results as OpenTdbResult[]).map((q, idx) => {
        const decodedCorrect = decodeHTMLEntities(q.correct_answer);
        const decodedIncorrect = q.incorrect_answers.map(decodeHTMLEntities);
        const options = [...decodedIncorrect, decodedCorrect].sort(() => Math.random() - 0.5);

        return {
          id: `q_${idx}_${Date.now()}`,
          category: decodeHTMLEntities(q.category),
          difficulty: q.difficulty,
          question: decodeHTMLEntities(q.question),
          options,
          correctAnswer: decodedCorrect,
        };
      });

      try {
        const redis = getRedis();
        if (redis) {
          await redis.set(todayKey, JSON.stringify(questions), "EX", 86400).catch(() => null);
        }
      } catch (e) {
        logger.debug({ err: e }, "[gaming.trivia] redis cache write failed");
      }

      return questions;
    }
  } catch (err) {
    logger.warn({ err }, "[gaming.trivia] opentdb fetch failed, using fallback questions");
  }

  return FALLBACK_QUESTIONS;
}
