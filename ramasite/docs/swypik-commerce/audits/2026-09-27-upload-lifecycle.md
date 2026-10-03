# Upload lifecycle repair (Azure)

All source changes/tests performed on Azure, candidate upload-audio-20260927-191040. No production configuration, data, API schema or deployment changes by this agent.

Files:
- components/upload/upload-controller.ts (new, testable lifecycle owner)
- components/upload/useUploadController.ts (same public API, useSyncExternalStore adapter)
- components/upload/useProcessingStatus.ts (result scoped to session and processing attempt)
- tests/unit/upload-controller-lifecycle.test.ts (new)

Fixes:
- Every start/resume/attach/retry owns an AbortController epoch. Late session creation after cancellation/supersession is aborted best-effort and does not start multipart transfer.
- Progress, multipart results, status lookup, completion and reprocess responses cannot change a cancelled/replaced operation. Progress after the parts promise settled cannot rewind completion.
- Cancellation updates client state synchronously; remote abort and draft cleanup follow. Queue backoff wakes on cancellation and cannot issue further completion requests.
- Retry recreates failed sessions with original file/name/source; retries complete without retransmitting parts; retries failed resume lookup and failed attach status lookup. Trim confirmed while starting/uploading is retained through retry.
- Completion and reprocess are single-flight. Repeated confirm/retry cannot dispatch duplicate requests while pending.
- Draft remember/delete ordering prevents a late IndexedDB save resurrecting a cancelled draft. Unmount invalidates client operations but preserves already-established recoverable drafts. Reattaching the same session after StrictMode-style dispose does not abort it.
- Polling caches are keyed by sessionId and pollKey; an old failure/ready result cannot terminate a new processing attempt. Visibility events cannot overlap status requests, terminal status stops polling, cancelled failures do not reschedule.

Validation: 25 unit tests passed in two files (13 new lifecycle + 12 existing upload-client-logic), Docker Azure node22, 1 CPU, 768 MiB, network none. Tests use delayed promises, fake timers and real controller transitions; no real uploads or payments. Full typecheck/build/browser verification owned by root.

Limits: Fetch complete/reprocess already accepted by server cannot be rolled back by an epoch; stale client responses are ignored, and DELETE is best-effort. Cancellation promise still waits for remote abort/local cleanup, preserving prior contract; state updates immediately. Actual hook rendering/polling interaction should be verified by root browser checks; controller lifecycle tests do not claim phone/browser end-to-end upload validation. No Studio/ERP/GPU changes.
