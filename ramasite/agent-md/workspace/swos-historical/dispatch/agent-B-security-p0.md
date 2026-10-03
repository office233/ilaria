# SWOS P0 — Agent B: Secret containment + process hardening

WORKTREE EXCLUSIV: E:\CEO\wt\swos-security-p0
BASE: cc688dd
Nu lucra în E:\nexus main.

Citește:
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\projects\swos\analysis\01-kernel-security.md
- E:\CEO\wt\swos-security-p0\AGENTS.md
Inspectează live core/coder, core/agent/workspace_tools.go și cmd/swypik-os.

## Obiectiv
Închide traseul verificat parent-env → process.run → stdout → Observation/prompt, fără să pretinzi sandbox complet.

1. Child process nu mai moștenește implicit environment-ul complet.
2. Construiește explicit environment minim/allowlisted necesar Windows. Fără ILARIA_API_TOKEN, API keys, tokens sau vars necunoscute default.
3. Tests reale: setează ILARIA_API_TOKEN și sentinel secrets în parent; process.run nu le vede.
4. Păstrează command execution normal, console decoding, cancellation, descendant cleanup.
5. Evaluează Job Object hardening (process/memory/CPU limits); implementează numai limite robuste/testabile.
6. Output redaction doar dacă este robust; nu simula protecție.
7. Documentează explicit: secret/process hardening, NU AppContainer/restricted-token sandbox final.

Scope writes: swypik-os\core\coder\**, swypik-os\core\agent\**, docs strict relevante.

## Gemini accelerator
provider_status; dacă Antigravity/Gemini 3.8 Flash AVAILABLE, MAXIM 5 antigravity_submit read-only pentru Win32/security review și adversarial tests. Dacă unavailable, continui.

## Reguli
Nu citi .env/secrete/data/cuda. Nu commit/push/deploy. Diagnostics după editări. gofmt. Final din swypik-os: go vet ./... și go test -count=1 -timeout 180s ./...; git diff final.

Raport final: threat path închis, teste, ce authority rămâne nesandboxed.
