# Swypik marketing claim guardrails

Verified against the local project state on 2026-09-28.

The marketing site should distinguish three states:

- **Shipping / verified now** — can be written as a present-tense capability.
- **Active development** — must be described as being built, tested or prepared.
- **Roadmap / target** — must never be presented as measured or already shipping.

## Swypik

Safe current claims:

- A Swypik web product is already running.
- The product combines video discovery and commerce.
- A separate native/mobile track exists and is still being prepared.

Do not publish App Store or Google Play availability until real store listings exist.

## Ilaria

Safe current claims:

- Romanian-first, English-capable AI research stack.
- Own Go inference/runtime work.
- Local-first inference is a core architectural direction and implemented project path.
- Tool-use work exists.
- Hippocampus-inspired one-shot memory research exists and can learn a fact from one exposure in the verified memory workflow.

Boundary:

- Do not market Ilaria as a replacement for frontier cloud models.
- Do not turn experimental arena/project runs into broad intelligence claims.
- A failed or non-promoted benchmark run must not be converted into a marketing win.

## SwypikOS

Positioning (owner decision, 2026-10-03): SwypikOS is presented as an operating
system — its own kernel, its own desktop, Ilaria built in. It is **not** marketed as
an application installed on Windows. The current Windows build is an internal
development host for the desktop and agent and is not mentioned in public copy.

Safe current claims:

- A first-party kernel seed boots via UEFI and passes 21/21 expected QEMU outcomes (emulation only).
- The SwypikOS desktop, the approval-gated Ilaria agent and its own search engine are built and tested internally.
- No Chromium/Electron/WebView inside the desktop.

Roadmap language:

- A broader agentic computing platform.
- Deeper system/device integration.
- Running on physical hardware and devices beyond the desktop.

Do not currently claim:

- that SwypikOS is a shipping, general-purpose OS ready for everyday use;
- that the kernel runs on physical hardware;
- verified universal hardware/driver support;
- measured ~25 MB RAM or ~50 ms startup unless those numbers are reproduced by a documented benchmark on the release build.

## Copy rule

Prefer concrete capability + status over superlatives. The site can be ambitious in vision while keeping implementation state explicit.
