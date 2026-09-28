# Cloudflare Realtime: Live shopping and Messenger calls

Swypik uses Cloudflare Realtime for all real-time media. LiveKit and MediaMTX have been removed (w5-realtime, 2026-09-27).

| Use case | Product | Why |
|---|---|---|
| Messenger calls: 1:1 and small groups, video or audio-only | **RealtimeKit** (meetings, presets, official web SDK + UI Kit, signed webhooks) | We get rooms, presets and a ready call UI without writing our own signaling. The audio-only preset costs about ¼ of the video preset. |
| Live shopping: 1 host to many viewers | **Realtime SFU** (raw HTTPS API) + optional **TURN** | Sub-second latency, the cheapest cost per GB, and no viewer cap. Chat, product pinning, the studio and feed cards stay on our own stack. |

## Architecture

### Live shopping (SFU)

```
Host browser ──offer──▶ POST /api/live/streams/[id]/publish ──▶ SFU sessions/new + tracks/new(local)
             ◀─answer──                                           (stores sfu_session_id, sfu_tracks)
Host browser ──every 7 s──▶ POST …/heartbeat {role:host}
             Redis live:host:<id> (TTL 20 s). The first heartbeat with an active
             local track (GET sessions/{id}) moves the stream scheduled → live.
Viewer ──POST …/watch──▶ SFU sessions/new + tracks/new(remote: host session) ──▶ SFU offer
       ──PUT  …/watch {answer}──▶ SFU renegotiate
       ──every 7 s──▶ POST …/heartbeat {role:viewer}  (Redis ZSET live:viewers:<id>)
Cron /api/cron/live-sweep (every minute, runCron lock): if the host heartbeat
       has expired, the stream is ended. Otherwise the viewer count is written to the DB.
Fan-out: Redis channel live:stream:<id> → the existing chat SSE (event: state).
```

- **Secrets never reach the browser.** Only our API holds the SFU App Secret. Viewer SFU sessions are bound to the stream in Redis (`live:vsession:<sessionId>`), so a client cannot renegotiate or heartbeat a session that belongs to a different stream.
- **Access rules** (`lib/live/access.ts`):
  - Only the creator (or an admin) can publish.
  - Anyone, including guests, can pull, but only while the stream is `live` and has a host session.
- **Going live.** A stream is never marked live on the client's word. It moves to live only after:
  - the SFU confirms an active track on the host session, and
  - the host heartbeat is alive.
- **Ending.** A stream ends in any of these cases:
  - the host presses End (`PATCH status=ended`);
  - the host heartbeat expires, detected either by the minute sweep or lazily by the next viewer heartbeat;
  - a stream was still `live` on a removed provider (`livekit`/`rtmp`). The sweep ends these because nobody can watch them.
- **Host reconnect.** Republishing creates a new SFU session and a new `sfu_published_at`. Viewers get it through SSE and pull again.
- **Not implemented yet:**
  - simulcast: the host sends a single 720p layer;
  - recording/replay: the raw SFU has no recording. For replays, add MediaRecorder upload to R2, or use RealtimeKit export at $0.01/min.

### Messenger calls (RealtimeKit)

```
POST /api/messenger/calls/token {conversationId, callType}
  → participant check → RealtimeKit meeting (title swypik_call_<uuid>)
  → add participant (preset swypik_call_video | swypik_call_audio, custom_participant_id = user UUID)
  → only then INSERT call_sessions (status ringing, provider cf_rtk, rtk_meeting_id)
  → { callId, authToken }  → client: useRealtimeKitClient + <RtkMeeting>
POST /api/messenger/calls/token {callId}  → joinCall → add participant → authToken
POST /api/messenger/calls/webhook  (rtk-signature RSA-SHA256, rtk-uuid dedup)
  meeting.participantJoined → call_participants + ringing→accepted (callee)
  meeting.participantLeft   → call_participants.left_at
  meeting.ended             → ended (answered) / missed (never answered), ended_at, end_reason
```

The `trg_calc_call_duration` trigger computes `duration_seconds`.

## Cloudflare dashboard setup (owner)

1. **Realtime SFU app.** Go to Dashboard → Realtime → SFU → *Create application*.
   - Copy the App ID into `CF_REALTIME_APP_ID`.
   - Copy the App Secret (API token) into `CF_REALTIME_APP_TOKEN`.
2. **TURN key** (recommended for mobile and corporate networks). Go to Realtime → TURN → *Create key*.
   - Copy the key ID into `CF_TURN_KEY_ID`.
   - Copy the key API token into `CF_TURN_KEY_API_TOKEN`.
   - Our API generates short-lived ICE credentials per viewer or host (`CF_TURN_CREDENTIAL_TTL`, default 4 h).
3. **RealtimeKit app.** Go to Realtime → RealtimeKit → *Create app*.
   - Copy the app ID into `CF_REALTIMEKIT_APP_ID`.
   - Copy the account ID from the dashboard URL/overview into `CF_REALTIMEKIT_ACCOUNT_ID`.
4. **Presets** (RealtimeKit → Presets). Create two presets for group calls:
   - `swypik_call_video`: can produce audio and video. Screenshare is optional.
   - `swypik_call_audio`: can produce audio only. Video is off.
   - Different names are fine: set them in `CF_REALTIMEKIT_PRESET_VIDEO` / `CF_REALTIMEKIT_PRESET_AUDIO`.
5. **API token.** Go to My Profile → API Tokens → *Create token* with the **Realtime / Realtime Admin** permission on the account, and put it in `CF_REALTIMEKIT_API_TOKEN`.
6. **Webhook.** Either use RealtimeKit → Webhooks in the dashboard, or register it through the API:
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/realtime/kit/$APP_ID/webhooks" \
     -H "Authorization: Bearer $CF_REALTIMEKIT_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"swypik-calls","url":"https://swypik.com/api/messenger/calls/webhook",
          "events":["meeting.started","meeting.ended","meeting.participantJoined","meeting.participantLeft"],
          "enabled":true}'
   ```
   The public key is fetched from `https://api.realtime.cloudflare.com/.well-known/webhooks.json` and cached for 6 h. You can pin it with `CF_REALTIMEKIT_WEBHOOK_PUBLIC_KEY`, a PEM where `\n` is allowed.
7. **Build flag.** Set `NEXT_PUBLIC_CALLS_ENABLED=1`. It is a build arg in `docker-compose.prod.yml` and shows the call buttons.
8. **Migrations.** Apply `20260927_0020` … `0023` (the deploy script applies them automatically).
9. **Cron.** `infra/hetzner/cron-worker/run.sh` already calls `live-sweep` every minute.

When the keys are missing, the APIs answer **503** (`live_unavailable` / `calls_unavailable`) and the UI shows the "not configured" state. Live also needs `REDIS_URL`.

### CSP

`next.config.mjs` adds the following:
- `connect-src https://*.realtime.cloudflare.com wss://*.realtime.cloudflare.com`, which the RealtimeKit SDK needs;
- `worker-src 'self' blob:`, which the SDK timer workers need.

You can override these with `CSP_REALTIME_CONNECT_SRC`. Live SFU signalling goes through our same-origin API. WebRTC media and TURN are not governed by `connect-src`.

⚠ Verify the exact RealtimeKit hosts in devtools on the first real call. The wildcard is derived from the SDK bundle.

## Costs (read 2026-09-25, see `infra-research.md`)

| Item | Price |
|---|---|
| SFU + TURN egress | **1,000 GB/month free** (shared), then **$0.05/GB**. Ingress is free. |
| RealtimeKit | Free during beta. After GA: **$0.002/participant-minute** for audio+video, **$0.0005** for audio-only, $0.010/min for export (recording/RTMP/HLS). |
| Stream (not used) | $1 per 1,000 minutes delivered. |

The examples below assume 720p at about 1.5 Mbps, which is about 0.68 GB per viewer-hour:
- **Live on the raw SFU:** about **$0.034 per viewer-hour**.
  - 10,000 viewer-hours/month ≈ (6,800 − 1,000 GB) × $0.05 ≈ **$290**.
  - For comparison: Stream ≈ $600, RealtimeKit viewers ≈ $1,200.
- **Calls:** 10,000 two-person video call-minutes ≈ **$40** at GA pricing. Audio-only is about a quarter of that.

## Files

- `lib/realtime/`: `config.ts` (env, `RealtimeUnavailableError`), `http.ts`, `sfu.ts`, `turn.ts`, `rtk.ts`, `rtk-webhook.ts`
- `lib/live/`: `access.ts` (rules + state machine), `media.ts` (publish/watch/heartbeat), `presence.ts` (Redis), `events.ts` (pub/sub fan-out), `sweep.ts`, `http.ts`
- `app/api/live/streams/[id]/{ice,publish,watch,heartbeat}`, `app/api/cron/live-sweep`
- `lib/messenger/{calls.ts,call-webhook.ts}`, `app/api/messenger/calls/{token,webhook}`
- Client:
  - `components/live/rtc/*` (plain `RTCPeerConnection`, no SDK)
  - `components/messenger/Calls/ActiveCallOverlay.tsx` (`@cloudflare/realtimekit-react` + `@cloudflare/realtimekit-react-ui` 2.0.2, pinned)
