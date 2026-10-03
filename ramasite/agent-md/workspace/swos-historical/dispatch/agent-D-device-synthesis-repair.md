# SWOS M1 — Device Synthesis Repair Round 1

WORKTREE EXCLUSIV: E:\CEO\wt\swos-device-synthesis-m1
Do not touch E:\nexus main or other worktrees.

Read:
- E:\CEO\projects\swos\analysis\11-device-kernel-qa.md
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- current swypik-os/core/devicesynth source

Independent QA verdict for Candidate D is REJECTED. Fix ALL D-1..D-5, not just tests.

D-1 CRITICAL — non-forgeable verification authority:
- STAGE/CANARY/ACTIVE must NOT accept a caller-constructed public VerificationResult as authority.
- Introduce a trusted verifier attestation mechanism. Prefer a stdlib cryptographic signature (e.g. Ed25519) or an equally strong opaque authority boundary that can be revalidated after journal reload.
- Bind attestation to exact CandidateDigest + HardwareBindingHash + ArtifactDigest + verifier identity/version + permitted TargetState + evidence summary.
- Journal must validate attestation before protected transitions and on reload.
- stale/tampered/fabricated attestations must fail closed.

D-2 HIGH — provenance:
- Candidate/model may reference evidence but may NOT self-approve it.
- VerificationRequest must receive a trusted approved-evidence registry/set externally.
- Require exact ID+digest membership; remove authority meaning from candidate-owned Approved bool or make it ignored/non-authoritative.

D-3 HIGH — artifact/test evidence:
- Verifier must hash actual built artifact bytes supplied from a trusted builder boundary and compare to manifest.
- Test pass evidence must come from trusted verifier/runner inputs/attestations, not candidate-populated Passed=true.
- Bind test evidence to candidate/artifact/contract and reject forged/stale evidence.

D-4 HIGH — capability observation:
- enforce closed ABI v1 capability vocabulary before policy allowlist;
- independent static/build capability observations are trusted verifier inputs, not candidate-owned fields;
- candidate omission of an observed effect must not bypass the check.

D-5 MEDIUM — graph:
- validate bus ParentID existence, self-parent, parent cycles;
- reject duplicate/self edges and define/enforce cycle policy for hierarchical dependency relations.

Add adversarial tests for every QA reproduction:
- fabricated VerificationResult cannot stage;
- tampered/stale attestation fails;
- self-approved provenance rejected;
- fake test Passed rejected;
- artifact bytes mismatch rejected;
- arbitrary capability string rejected even if caller allowlist includes it;
- omitted candidate observations cannot hide trusted scanner observation;
- bus missing parent/cycle and device self/cycle rejected.

Preserve substrate independence and Ilaria-as-proposal-only boundary.

Final:
gofmt; go test -count=1 -race ./core/devicesynth; go vet ./...; go test -count=1 -timeout 180s ./...; git diff --check.
No commit/push/deploy. Report exact results.