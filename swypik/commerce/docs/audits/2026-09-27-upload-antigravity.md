# Upload and audio audit — 2026-09-27

All project changes/tests/builds performed on Azure. Workstation is SSH and Antigravity CLI transport only.

Three real Antigravity CLI review conversations used the available exact model gemini-3.8-flash-high (user requested Gemini 3.8 Fast). Read-only, inline bounded source context; no repository edits or additional tool permissions granted to Antigravity.

- Audio/recording: d9689927-5ad9-47fa-84a5-5e4b9044c0c2
- Upload/editor UI: 05eccd19-e2b3-414c-b53f-a333ac796122
- Upload lifecycle: ad10f8ab-3e1e-409b-8347-9219e6cd9e5e

Initial large prompts were truncated by the transport. Each conversation received a smaller, explicitly delimited supplement, and all six calls completed successfully. Findings were verified against full Azure source before implementation.

## Confirmed and addressed
- Edit preview hardcoded muted with no playback controls. Explicit native playback controls, sound enabled on user playback; no audible autoplay dependency.
- Cover capture unconditionally resumed playback, lacked a bounded seek and visible failure. Preserve paused state, bound seek, report failures, guard stale completion.
- Preview trim allowed playback outside selected range. Bound playback, including frame/time checks and range changes; paused cover inspection remains possible.
- Cover upload marked success before HTTP success, skipped retries, and did not key by video. Serialize and deduplicate by video/blob, mark only success, await before publish; retries on explicit submission.
- Cover object URL leak and stale file/draft responses. Revoke URL, generation guards, invalid draft fallback.
- Duplicate publish and premature publish during completion. Synchronous guard and wait for processing/ready.
- Late session creation, progress and completion after cancellation; retry create no-op; noncancelable backoff; previous polling state. Controller ownership and stage-aware retries; dedicated deferred-promise regression tests.
- Canvas filter capture failure leaked hidden media/render resources; stop did not remove metadata listener. Clean up derived resources while retaining original audio/camera tracks.

## Withdrawn / unverified claims
Missing audio reattachment, invalid Opus MIME, absent cancellation implementation, incorrect trim-ref ordering and mission baseline assignment were not valid findings from full source. Do not reproduce them as confirmed bugs.
Background canvas recording timing and late canvas dimension changes are cross-device risks, not reproduced defects. Physical iPhone/Android capture and actual speakers have not been tested by these code/unit checks.
Antigravity did not review every server route or the entire repository. This is a focused audit, not a claim that all Swypik code is error-free.

## Operational finding
No active video worker was identified on the active web/data nodes; PostgreSQL queue had 13 completed jobs and no active heartbeat. Worker activation and audio encoding verification tracked separately. Existing FFmpeg code preserves source audio in playback HLS/MP4; transcription audio is a separate artifact.
