# Connecting Ilaria to SwypikOS

SwypikOS does not ship or simulate a model. Chat and the agent use one
configured Ilaria service. Nothing answers until that service is reachable.

## Configure the desktop

Settings live in `%LOCALAPPDATA%\SwypikOS\settings.json` (created by the
Settings tab, or by hand):

```json
{
  "ilaria_url": "https://ilaria.<your-app>.azurewebsites.net",
  "workspace": "D:\\projects\\demo",
  "compute": { "contribute": false }
}
```

- `ilaria_url` must be an origin: HTTPS, or `http://127.0.0.1:<port>` for a
  local development service. Credentials, paths and query strings are rejected.
- The bearer token is **not** stored in `settings.json`. Put it in
  `%LOCALAPPDATA%\SwypikOS\ilaria.token` (first line), or set `ILARIA_API_TOKEN`.
  The token is sent only over HTTPS and must be at least 32 characters.
- From the app: Settings tab, `/ilaria https://…` switches the endpoint without a
  restart, and `/test` calls `GET /health`.
- `swypik-os.exe -ilaria-url https://…` overrides the file for one launch;
  `-check` prints the resolved configuration without starting anything.

## Service contract (current)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /health` | none | HTTP 200 when ready |
| `POST /v1/chat` | `{"prompt": "...", "history": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}` | `{"reply": "..."}` or `{"error": "..."}` with a non-200 status |

Limits enforced by the client: request body ≤ 64 KiB (oldest complete turns are
dropped first), response ≤ 128 KiB, 130 s timeout, no redirects, no proxy.

### How the agent uses it

The agent sends one stateless `/v1/chat` prompt per step. The prompt contains
the goal, the tool list and the recorded observations, and asks for exactly one
JSON object:

```json
{"action":"tool","tool":"workspace.edit","arguments":{"path":"main.go","old":"…","new":"…","expected_sha256":"…"}}
{"action":"finish","summary":"…"}
```

Markdown fences around the object are tolerated. An invalid reply gets one
repair request; a second invalid reply fails the run. Nothing runs without the
user's approval in the desktop.

Tools available to the agent: `workspace.list`, `workspace.read`,
`workspace.write`, `workspace.edit`, `process.run`, `search.query`,
`network.interfaces`. Training Ilaria on this exact format (including
reading before editing and passing `expected_sha256`) is what makes it reliable.

## Contract upgrades worth adding to Ilaria

1. **Native tool calling:** `messages` + `tools` in, `tool_calls` out. This
   removes JSON-in-text parsing and allows parallel read-only calls.
2. **Streaming** (Server-Sent Events) so replies appear as they are generated.
3. **`POST /v1/embeddings`** for semantic search: the local index can then rank
   by meaning (hybrid BM25 + vectors) while documents stay on the device.
4. **Context compaction** so long agent runs are not limited by the 64 KiB
   observation budget.

## A language for Ilaria

If Ilaria learns a dedicated action language, keep one rule: the language
compiles to the tool calls above, and each side-effecting call is still shown
to the user for approval. The runtime, not the model, enforces what may run.
