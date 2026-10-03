# IMC-125M production attribution & provenance

Attribution manifest: `2943b8c9ef398b3b50f7e0100aa0ec844f57bdeee66ad45d21483bdc86f0fdc9`
Review packet: `21cb5fe4ea956009259aff668a0c09c1dd1aede0a9aa0a48a542ee59670c1639`

This document records exact source revisions, declared licenses and provenance evidence. It does not itself grant training rights.

## External sources

### apache_nuttx

- Declared license: Apache-2.0 or Apache-2.0-compatible per repository policy, filtered per-file by SPDX
- Revision: `4295024832a0f70820156d2a7e6e09d68897e91f`
- Source manifest SHA-256: `10419ca03fb8211ce862f4bd38ee6a614feb6c2f2494f2bd0baaafc338992040`
- Candidate documents: 18,156
- Evidence:
  - https://github.com/apache/nuttx/blob/master/LICENSE
  - https://github.com/apache/nuttx
  - https://nuttx.apache.org/docs/latest/introduction/resources.html
- Review obligations:
  - ingest only per-file SPDX expressions allowed by the corpus policy
  - review Apache-2.0 attribution and NOTICE handling for corpus artifacts and model documentation
  - retain exact repository revision and per-file provenance for every accepted file

### freebsd_licensed_tree

- Declared license: BSD-2-Clause collection with file-level exceptions
- Revision: `52b2056849e4f77581594b9ca21ac3feb60429c3`
- Source manifest SHA-256: `28fae86e168fab2bbb9d3cb51731cdf5e99529620f0894b8fcf09a1a70f0d6c1`
- Candidate documents: 11,741
- Evidence:
  - https://github.com/freebsd/freebsd-src
  - https://github.com/freebsd/freebsd-doc/blob/main/documentation/content/en/articles/license-guide/_index.adoc
- Review obligations:
  - apply per-file SPDX allowlist and exclude cddl/contrib/other non-allowlisted material
  - retain file-level provenance and applicable copyright/license notices

### freertos_kernel

- Declared license: MIT
- Revision: `8be86d4a24fd4091f8f4192018423ab590f408db`
- Source manifest SHA-256: `6e1558c1f17b8869c32e326cb9706db372530676d154cd9dbc02581c4d2a8960`
- Candidate documents: 636
- Evidence:
  - https://github.com/FreeRTOS/FreeRTOS-Kernel/blob/main/include/FreeRTOS.h
- Review obligations:
  - retain MIT copyright/license notice in attribution records
  - keep acquisition scoped to the FreeRTOS-Kernel repository and separately review submodules or external ports

### opencode_reasoning_split0

- Declared license: CC-BY-4.0 with per-row CC-BY-4.0/Apache-2.0/MIT allowlist
- Revision: `20a1ca19c0d050fe9057fc08339d6b370ec1c67a`
- Source manifest SHA-256: `18610249e57ea29567492982cb396d43f7357b96c6a04fe4733f855aa837bc21`
- Candidate documents: 120,000
- Evidence:
  - https://huggingface.co/datasets/nvidia/OpenCodeReasoning/blob/20a1ca19c0d050fe9057fc08339d6b370ec1c67a/README.md
  - https://creativecommons.org/licenses/by/4.0/
- Review obligations:
  - retain per-row license provenance and attribution for accepted samples
  - restrict ingestion to rows whose embedded license is CC-BY-4.0, Apache-2.0 or MIT
  - review upstream competitive-programming problem provenance before production eligibility

### openmath_reasoning_cot

- Declared license: CC-BY-4.0
- Revision: `d3d08664755704f422af97d43a7ff0ded4bd95df`
- Source manifest SHA-256: `7585e6a7670cfb73d9460d4d2ffbabb8888747b5b882b4b465fb1f2f50796fde`
- Candidate documents: 100,000
- Evidence:
  - https://huggingface.co/datasets/nvidia/OpenMathReasoning/blob/d3d08664755704f422af97d43a7ff0ded4bd95df/README.md
  - https://creativecommons.org/licenses/by/4.0/
- Review obligations:
  - retain attribution and exact NVIDIA dataset revision/provenance for accepted rows
  - review attribution and pass-through rights for underlying AoPS/MATH problem content before production eligibility

### openscience_reasoning_2

- Declared license: CC-BY-4.0
- Revision: `174b02c9cdf231f220765b2a1d5ece4550921894`
- Source manifest SHA-256: `846b524041889478fae6b6483d69d76b24488e5b726e00eeba8b71a6a0dd8aed`
- Candidate documents: 80,000
- Evidence:
  - https://huggingface.co/datasets/nvidia/OpenScienceReasoning-2/blob/174b02c9cdf231f220765b2a1d5ece4550921894/README.md
  - https://creativecommons.org/licenses/by/4.0/
- Review obligations:
  - retain CC-BY-4.0 attribution and exact NVIDIA dataset revision/provenance for accepted rows

### wiki_en

- Declared license: CC-BY-SA-3.0 + GFDL (dataset card)
- Revision: `b04c8d1ceb2f5cd4588862100d08de323dccfbaa`
- Source manifest SHA-256: `38fc03e155a4407c4f5c9ffcdc31bf0b0bc4674dbbae8e95d06136272f754bbe`
- Candidate documents: 1,200,000
- Evidence:
  - https://huggingface.co/datasets/wikimedia/wikipedia/blob/main/README.md
  - https://foundation.wikimedia.org/wiki/Legal:Wikimedia_Developer_App_Guidelines
  - https://foundation.wikimedia.org/wiki/Terms_of_Use
- Review obligations:
  - define attribution path to article authors/source history
  - review share-alike implications for redistributed derived corpus artifacts
  - retain provenance needed to satisfy reuse obligations

### zephyr

- Declared license: Apache-2.0
- Revision: `f0bdf59a0b7d1b4dadbec339662d764cba78138a`
- Source manifest SHA-256: `4cbbc9c8601509f62f5b727b1b372a9089994e1b42a205d991a73d0d787a53b9`
- Candidate documents: 13,417
- Evidence:
  - https://docs.zephyrproject.org/latest/LICENSING.html
  - https://docs.zephyrproject.org/latest/contribute/guidelines.html
  - https://github.com/zephyrproject-rtos/zephyr/blob/main/LICENSE
- Review obligations:
  - ingest only per-file SPDX/REUSE entries allowed by the corpus policy
  - review Apache-2.0 attribution and NOTICE handling for corpus artifacts and model documentation
  - retain exact repository revision and per-file provenance for every accepted file

## First-party provenance

### first_party_contracts

- Attestation identity: `e70c709bced17a5a7da0fd07f3636e66a02df06041968a8a433fe0e49531f6ad`
- Attestation scope: `0f136c85e91a0523bd85261dcac28903b6503ec078f4e187a2fe663360f4e111`
- Pinned files: 7

### first_party_trajectories

- Attestation identity: `8bd361bbd0fafbe68200939e57f425517b81a127dd9d42abcdfd51cfb18f203e`
- Attestation scope: `bcb8d1191f62f150ca2d3970c83afd5ba0294231119868a224a06c85ec9cb7bd`
- Pinned files: 5
