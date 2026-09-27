# Azure development topology: two active VMs

Applied on 2026-09-27 at the user's explicit request, after confirming no public users and reviewing dependencies.

| VM | Verified final state |
| --- | --- |
| swypik-prod-web-1 | Running |
| swypik-prod-data | Running |
| swypik-prod-web-2 | Deallocated |
| swypik-prod-worker-1 | Deallocated |

The worker had one healthy video-worker container and no active ffmpeg processes at inspection. No queue contents were read or deleted. Video processing is unavailable while the worker is deallocated; queued jobs must wait until it is restarted. The web-1 cron service remains running.

The web-1 application and platform API were healthy locally. Its public and preview Cloudflare connectors were active. Before deallocating web-2, its cloudflared-swypik service was stopped (left enabled for future boot). Public web and API health continued returning HTTP 200 with that connector inactive. No DNS, database, secrets, deployment scripts or application configuration was changed. VM disks and network resources remain intact.

Expected compute saving at the previously checked Linux retail rate: 2 * USD 0.097/hour * 730 hours = **USD 141.62/month**. Remaining VM-only compute reference cost is USD 164.25/month. Disks, NAT, public IPs, storage and other services continue billing. This change removes the second web replica, so web-1 failure or deployment restart can now interrupt service.

## Re-enable only when needed

Run `az vm start -g rg-swypik-prod -n swypik-prod-worker-1` for video testing; verify container health and queue progress after boot, then deallocate it again when finished. The container was not manually stopped, preserving its restart policy.

For web redundancy, run `az vm start -g rg-swypik-prod -n swypik-prod-web-2`, verify the application/API release and health, and verify the enabled cloudflared-swypik service reconnects. Refresh an outdated release before intentionally bringing it back into public traffic.

Existing infrastructure and deploy inventories still describe four VMs. The Swypik deployment agent must account for the two intentionally deallocated hosts, rather than starting them merely to satisfy the previous topology. No cross-thread message was sent.
