# SWOS M1 — Native Kernel Seed Repair Round 1

WORKTREE EXCLUSIV: E:\CEO\wt\swos-native-kernel-seed-m1
Do not touch E:\nexus main or other worktrees.

Read:
- E:\CEO\projects\swos\analysis\11-device-kernel-qa.md
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- current swypik-kernel source

Independent QA verdict for Candidate E is REJECTED. Fix ALL E-1..E-6 in the first-party kernel seed. Do not install QEMU/toolchains and do not fake boot evidence.

E-1 HIGH fixed-width strings:
- decoded model/firmware version fields must never expose unterminated C strings;
- choose canonical length+bytes or reserved-NUL encoding; reject noncanonical wire input;
- add adversarial full-width nonzero tests.

E-2 HIGH resource ranges:
- reject zero/invalid lengths by resource kind;
- reject start+length overflow before any capability creation;
- add sensible IRQ/config/control constraints and overlap policy where required for safety;
- targeted UINT64_MAX wrap tests.

E-3 MEDIUM canonical wire:
- every reserved/padding byte required by canonical v1 must be zero on decode;
- add tampered reserved-byte tests.

E-4 MEDIUM capability generation wrap:
- stale handle must never revive.
- on generation exhaustion retire the slot permanently or use a stronger non-wrapping epoch design.
- add targeted near-wrap test without billions of iterations (test hook/internal setup acceptable).

E-5 MEDIUM IPC authority:
- sender authority must be validated at IPC boundary using capability table + domain + lease fence + required endpoint SEND right, or field must be unambiguously untrusted with a mandatory checked wrapper that authoritative consumers cannot bypass.
- Prefer checked API and test revoked/forged/wrong-domain/wrong-fence handles.

E-6 MEDIUM topology:
- reject self-parent;
- bounded cycle detection for parent hierarchy;
- reject self/duplicate/cyclic hierarchical topology edges according to documented edge semantics.

Keep:
- no Linux source/dependency;
- build writes only under out;
- UEFI seed non-destructive;
- QEMU remains explicit blocker, not a failure to repair here.

Final independent commands:
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 twice; compare SHA256; objdump -x BOOTX64.EFI; git diff --check; root/swypik-os go vet/test.
Compile C with -Wall -Wextra -Werror.
No commit/push/deploy. Report exact results.