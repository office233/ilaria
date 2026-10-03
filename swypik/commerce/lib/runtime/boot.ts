/**
 * Pornirea unei replici web (runtime Node), apelată din `instrumentation.ts`.
 * 1. fail fast dacă lipsesc secretele comune tuturor replicilor;
 * 2. handlerele SIGTERM care golesc stream-urile SSE (vezi ./shutdown.ts).
 */
import { assertProductionEnv } from "./env-check";
import { installShutdownHandlers } from "./shutdown";

export function bootNodeRuntime(): void {
  assertProductionEnv();
  installShutdownHandlers();
}
