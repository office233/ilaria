# Azure: Swypik, SwypikOS and Ilaria

Audit date: 2026-09-27. MultiERP is excluded. No Azure resources were created, changed or deleted; no deployment or training was started.

## Verified credit

The active Azure startup sponsorship credit started September 23, 2026 and expires **June 20, 2027 at 19:25:09 UTC**. Original amount: **USD 5,000**. Latest pending-charge event reports **USD 4,977.19 remaining**, after USD 22.81 usage. The lot's USD 5,000 closed balance precedes pending charges. Metering can lag.

Billing currency is EUR. The credit record's September conversion is **0.858663918942126 EUR/USD**; future conversions can differ. Approximately **266 days** remain.

| Observed or calculated item | Amount |
| --- | ---: |
| Reported September consumption through partial September 27 | EUR 19.5837 |
| Recorded production consumption on September 26 | EUR 10.9841 |
| Three Linux D2as_v7 at USD 0.097/hour plus one E2as_v7 at USD 0.128/hour, 730 hours | USD 305.87/month |
| Observed daily production rate projected across 266 days | about USD 3,403 |
| Remaining credit after that projection | about USD 1,574 |

This is a scenario based on one recorded day, not a guaranteed forecast. Disks, NAT and IP charges are included in observed usage but additional to VM-only retail pricing. Traffic, backup growth, logs and inference can raise consumption. Deleting ERP files alone will not remove shared VM charges.

Recommended operating target: **USD 500/month total**, approximately **USD 400 infrastructure + USD 100 incremental AI experiments**. Across 266 days this leaves approximately USD 600 reserve. At September's conversion the target is approximately EUR 429/month. These are proposed targets, not configured limits. Existing EUR 450 production and EUR 500 AI monthly budgets together are too generous for this envelope; budgets alert rather than automatically stopping consumption.

## Decision

Reuse Swypik's existing Azure deployment: two web VMs, one database VM and one worker VM in Sweden Central. No GPU is present. The inspected Foundry account named ilaria-core-us-resource has no model deployments; it is not evidence that Ilaria is hosted there.

SwypikOS remains a local desktop client. Swypik and SwypikOS should share the Ilaria inference contract, with application authentication in front of inference. Keep training separate: Colab H100 pilot first, larger temporary GPUs after dataset and throughput validation. External Colab/NVIDIA costs do not consume Azure credits.

## Prepared integration and remaining steps

- Ilaria `cmd/ilaria-serve`: opt-in TLS serving with a runtime bearer credential; local serving remains default. Browser-origin restrictions remain enforced.
- SwypikOS `core/ilaria/backend.go`: authenticated HTTPS, redirect refusal and bounded requests/responses. `-ilaria-url` and runtime `ILARIA_API_TOKEN` support an operator-controlled pilot. A shared service token must not be embedded in publicly distributed clients; those need per-user gateway authentication.
- Swypik `lib/ai/ilaria.ts` and `app/api/ilaria/chat/route.ts`: server-only HTTPS transport, existing administrator sessions, five requests per user per minute, bounded JSON and generic upstream failures. Configure `ILARIA_API_URL` and `ILARIA_API_TOKEN` on the server. No UI or production shopping-AI replacement is included.
- Measure CPU RAM, latency and concurrency on an isolated serving target before assigning production capacity. Do not load inference on existing two-vCPU web/database VMs without measurements.
- Linux GPU serving is blocked by the current Go NVRTC/driver bridge: real bindings are Windows-specific; Linux uses error-returning stubs. Compilation alone does not prove Linux CUDA works.
- Configure a trusted certificate, service credential and serving host, then verify real-model responses through both clients. These deployment steps remain outstanding.
- Evaluate shopping-specific structured output before replacing the existing shopping orchestrator, whose prompts exceed the small model's available context budget.

## Evidence

Live Azure CLI inventory and Consumption `lots`, `events` and Cost Management `query` supplied account-specific figures. The public Retail Prices API supplied reference Linux VM rates.

- [Credit balance and expiry semantics](https://learn.microsoft.com/en-us/azure/cost-management-billing/benefits/credits/mca-check-azure-credits-balance)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- [Budgets are alerts, not spending stops](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets)

Security tests exercise token/TLS boundaries, redirects, history validation, body limits and failure handling. They do not certify deployed integration or model quality.

Validation completed: Ilaria `go vet ./...` and full `go test -count=1 -timeout 180s ./...` passed. SwypikOS vet passed; its full suite passed with `-p 1` after an initial compiler import-file error (the affected package also passed independently). Swypik `npm run typecheck` and all four new Ilaria Vitest cases passed. Existing unrelated web tests were not rerun.
