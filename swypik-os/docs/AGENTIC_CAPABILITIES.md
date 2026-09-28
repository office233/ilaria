# SwypikOS: agentic capabilities and implementation contract

Status: proposed implementation plan, NOT an implemented feature manifest.
Observed: 2026-09-28. Target: native Windows EXE; no Electron or embedded browser UI.
Source baseline: 0e3871f86198d6a82a5221287309e5e3df86e603 plus the existing uncommitted worktree.

## 1. What is available now

The native application contains real library primitives, not a complete autonomous coding/computer-use agent.

| Capability | Observed implementation | Missing integration |
| --- | --- | --- |
| List files | `core/coder/coder.go:48-77`, used by the Files panel | Full navigation, selection and paging |
| Read file bytes | `core/coder/coder.go:89-95` | Registered agent tool and editor/file-preview flow |
| Write files | `core/coder/coder.go:80-85` | Scope, diff approval, conflict detection, safe replacement |
| Generate code | `core/coder/coder.go:165-211` | Actual model-based code generation; current implementation selects templates |
| Execute commands | `core/coder/coder.go:103-162` and `shell_windows.go` | Agent registration and OS-level security boundary |
| Agent planning | `core/agent/planner.go` and `runtime.go` | Wiring into the Windows entrypoint; current planner explicitly disallows writes and shell |
| Durable agent store | Linux store exists | `store_other.go` explicitly rejects Windows |
| Browser/desktop control | Available tools in the external Antigravity connection | Native Swypik MCP client, approval broker and Windows UI Automation adapter |
| Code intelligence | External VS Code bridge tooling exists | Bridge at 127.0.0.1:3005 unavailable during this audit; no native integration |

`go list -deps ./cmd/swypik-os` does not include `core/agent` or `core/network` at this baseline. A package existing in the repository does not prove the desktop invokes it. The conversational assistant's 46 Antigravity tools are not automatically tools of SwypikOS.exe.

### Isolated executable probe

Evidence: `out/hands-audit-20260928-083509-1ea484/primitive-probe.json`.

Direct library calls in a generated temporary fixture verified:

- File creation, content readback and directory listing succeed.
- `echo SWYPIK_HANDS_TERMINAL_OK` executes successfully through the existing command engine.
- Writing the same fixture path again overwrites it without a separate approval.
- Requests for a Unicode grapheme segmenter and a binary red-black tree produce the same filename and code template.
- `agent.ReadOnlyTools` registers `network.interfaces` and `workspace.list`, not file editing or terminal tools. Other consumers may register additional tools; this is the factory's inventory, not a claim about every platform.

Focused tests passed: `go test -count=1 -timeout=2m ./core/coder ./core/agent ./ui/engine`.
The focused run does not replace the complete suite or clear the earlier log-uniqueness failure. No paid inference, competing-agent benchmark, production source edit, or real-user-file overwrite was performed by this probe.

## 2. Product objective

Build an independent, model-agnostic Windows agent runtime that completes verified development and desktop workflows. Optional adapters to other agents are integrations, not the core implementation. An EXE wrapper alone does not establish coding quality or agent capability.

The decisive acceptance scenario is:

> Given an approved project and a reproducible failing test, inspect the relevant files, propose and apply a minimal authorized patch, run diagnostics and tests, open the changed file at the relevant location, verify the application where applicable, and return the diff plus verifiable evidence. Preserve unrelated user changes.

The first release of that scenario uses a disposable fixture/worktree, not unrestricted access to the user's entire disk.

## 3. Proposed architecture

```text
Native Win32 desktop
  -> session / plan / diff / approvals / execution events
  -> agent manager and model adapter
  -> typed tool registry with runtime health
  -> local policy and execution broker
       -> bounded workspace read, search, patch and Git adapters
       -> process runner and diagnostics adapters
       -> optional authenticated MCP / Antigravity adapter
       -> Windows UI Automation client
       -> browser semantic / site-tool adapter
  -> durable state, evidence store and verification gates
```

Each tool definition needs an input schema, effect classification, resource scope, output limit, timeout, health state and verifier. Suggested states: unavailable, disconnected, needs_permission, ready, running and failed. These must reflect observations, not hardcoded READY labels.

Discovered MCP metadata is not authorization. The broker enforces its own allowlist, scope and approval policy. Authentication, cancellation, request identifiers and bounded output are part of the transport contract. Remote side-effecting calls with unknown outcomes must not be automatically retried.

Native file and terminal operations must remain usable without a browser. Controlling an external Chrome tab is optional tool use, not a Chromium renderer embedded in the desktop. Reusing the current separate Node-based bridge would create an optional external tool dependency; it must not be described as a dependency-free implementation of all capabilities.

## 4. Required tool families

### Workspace and code

`workspace.list`, `workspace.read`, `workspace.search`, `workspace.symbols`, `workspace.plan_patch`, `workspace.apply_patch`, `workspace.create`, `workspace.diff`, `editor.open`.

Reads are bounded and scoped, with line ranges and source hashes. Distinguish viewing a file's contents, opening it in an editor, and executing a file. Opening an arbitrary file association must not silently run scripts or installers. Secret files and external paths require separate scope.

Patches carry expected preimage hashes and exact target paths. Revalidate under a write lock immediately before applying; reject stale content. Handle Windows reparse points, junctions, alternate data streams and UNC paths explicitly. New-file creation must be exclusive by default. Keep a journal of owned changes, and never use blanket Git reset as rollback. Multi-file partial failure needs a recoverable transaction design, not an unqualified atomicity claim.

### Execution and code intelligence

`process.run`, `process.cancel`, `diagnostics.collect`, `symbols.references`, `symbols.definition`, `tests.run`, `git.status`, `git.diff`.

Prefer explicit executable and argv to shell strings. Tests and build scripts are code execution, not automatically safe read-only operations. A Windows Job Object controls process lifetime; it is not a complete filesystem/network sandbox. The isolation boundary must be designed and tested separately.

Use LSP when available and useful; record diagnostics with document versions. Fall back to compiler/linter/test commands when the bridge is unavailable. Never report a clean LSP result from an unreachable server.

### Computer and browser control

`desktop.windows`, `desktop.snapshot`, `desktop.invoke`, `desktop.fill`, `desktop.focus`, and semantic browser tools.

Use UI Automation identifiers/patterns and refreshed observations. A stale element reference must fail rather than click unrelated content. Use observed screenshots only when semantics are unavailable. Verify postconditions after an action. Do not bypass UAC or interact with secure credential surfaces automatically. Maintain application/window scope to avoid typing into the user's unrelated work.

### Agent coordination

`task.create`, `task.inspect`, `task.cancel`, `evidence.attach` and model-adapter operations.

Use a coordinator, bounded implementation workers, and an independent verifier where valuable. Do not add workers merely to increase a count. Start with conservative concurrency and adjust using measured memory, CPU, model limits and task independence. Worktrees isolate candidate changes, not arbitrary process privileges. Merge through one reviewed, conflict-aware path.

## 5. Autonomy policy

Three proposed modes:

1. Inspect: approved-project reads, search and planning; no execution or writes.
2. Project autonomous: authorized scoped edits and explicitly permitted build/test execution; diff and evidence mandatory.
3. External actions: per-action consent for privileged system changes, network reconfiguration, publishing, deletion outside the work area, payments, or communications.

File contents, search results, tool results and web pages are untrusted data. They cannot expand permissions. Credentials stay in an appropriate OS-backed store and are not included in model context by default.

A durable checkpoint is not permission to replay a side effect. After interruption, reconcile observed state and require fresh authorization where necessary. Never erase user changes made after a checkpoint.

## 6. Performance design

Optimize the entire task, not just the renderer:

- Retrieve a repository map plus relevant symbols/slices; avoid re-sending the whole repository every turn.
- Invalidate cached evidence by content/version changes. Do not reuse stale diagnostics as current facts.
- Load relevant tool schemas on demand; batch independent reads and cap output.
- Stream model output and tool progress without blocking the UI thread.
- Separate model latency, broker overhead, disk/CPU work, test time and user approval time in traces.
- Parallelize independent work only; serialize conflicting writes and cap costly verification.
- Record model identity, provider, configuration and backend availability. Ilaria/Ilaria remains a real inference dependency, not a label that guarantees a strong model.

No latency, RAM, token saving or superiority number is claimed before measurement.

## 7. Comparative acceptance plan

Initial proposed suite: 30 tasks, with real fixtures and deterministic validators still to implement.

| Group | Tasks | Acceptance focus |
| --- | ---: | --- |
| Bug fixes and feature edits | 10 | Held-out tests, minimal authorized diff, no regressions |
| Cross-file refactors | 8 | Reference completeness, public-contract preservation |
| Browser/desktop workflows | 6 | Correct target and observed postcondition |
| Recovery and adverse conditions | 6 | Conflict detection, lost bridge, cancellation, corrupt state, permission denial and untrusted instructions |

Compare coding agents on common coding tasks; report desktop-only capabilities in a separate track rather than treating unsupported tasks as coding failures. Pin agent versions, models, reasoning settings, repository snapshot, hardware, permissions, budget and tool configuration. Use the same model for harness-only comparisons where supported, and distinguish whole-product comparisons when models differ. Repeat tasks and report uncertainty and individual failures.

Primary measures: independently verified completion, regressions, preservation of unrelated files, wall time to a correct result, user interventions, cost/tokens, peak resources and cancellation/recovery correctness. Agent-written success messages and unvalidated benchmark submissions do not count as passes. No Codex/Claude Code/OpenCode comparison has been executed in this audit.

## 8. Delivery gates

Gate 0: resolve known log collision, unsafe replacement and multi-owner index issues; establish a reproducible green baseline.

Gate 1: one real Windows path from prompt through approved tool use to verified fixture edit, with durable run state and a genuine configured model. Add content read, scoped patch, test and diff tools before broad desktop privileges.

Gate 2: wire authenticated optional Antigravity/MCP, editor/LSP health, and semantic desktop/browser tools. Exercise disconnect/reconnect and stale-observation scenarios.

Gate 3: add bounded multi-agent coordination, incremental context and performance tracing. Preserve one accountable final verifier.

Gate 4: run the pinned comparative suite and publish task-level evidence. Claim superiority only for the measured configuration and task population.

## 9. External design references

Official documentation checked on 2026-09-28; these establish existing mechanisms, not benchmark superiority:

- OpenAI, MCP: https://developers.openai.com/codex/mcp/
- OpenAI, Windows sandbox: https://developers.openai.com/codex/windows/
- Anthropic, subagents: https://code.claude.com/docs/en/sub-agents
- Anthropic, checkpointing: https://code.claude.com/docs/en/checkpointing
- OpenCode, tools: https://opencode.ai/docs/tools/
- OpenCode, LSP: https://opencode.ai/docs/lsp/
- Microsoft, UI Automation: https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32

This document records a verified baseline and proposed engineering work. It does not implement the missing capabilities.
