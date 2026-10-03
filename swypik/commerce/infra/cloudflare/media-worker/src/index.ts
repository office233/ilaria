import { handleMediaRequest } from "./handler";
import type { CacheLike, ExecutionContextLike, MediaWorkerEnv } from "./types";

function edgeCache(): CacheLike | null {
  const storage = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches;
  return storage?.default ?? null;
}

const worker = {
  fetch(request: Request, env: MediaWorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    return handleMediaRequest(request, env, ctx, edgeCache());
  },
};

export default worker;
