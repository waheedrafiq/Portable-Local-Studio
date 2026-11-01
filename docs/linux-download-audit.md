# Linux setup download audit

Audited 2026-11-01. Scope: every Linux executable acquisition path in
`scripts/setup/*.sh`, including package-manager installs and the CUDA source
fallback. Only release metadata and checksum text were fetched for this audit.
No upstream executable/archive was downloaded or executed, and no installation
script was run.

## Published evidence and pinned downloads

The [reviewed manifest](../scripts/setup/linux-downloads.sha256) contains 15
exact-URL SHA-256 pins. Expected values were copied from the following upstream
sources, never calculated from downloaded executables.

| Source and selected release | Linux downloads used by setup | Published verification evidence |
| --- | --- | --- |
| Node.js `v22.12.0` | `node-v22.12.0-linux-x64.tar.xz` (1) | Official [SHA-256 manifest](https://nodejs.org/dist/v22.12.0/SHASUMS256.txt) and [PGP-signed manifest](https://nodejs.org/dist/v22.12.0/SHASUMS256.txt.asc). [Node verification instructions](https://github.com/nodejs/node#verifying-binaries) document the release-key trust chain. |
| stable-diffusion.cpp `master-685-19bdfe2` | Ubuntu 24.04 x86_64 CPU, Vulkan, ROCm 7.13.0 ZIPs (3) | Each selected asset has a `sha256:` digest in the [official repository's release API response](https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/master-685-19bdfe2). No separate checksum manifest or binary signature file appeared in its asset list. |
| llama.cpp `b11418` | Ubuntu CPU and Vulkan x64/arm64, CUDA 12.8 x64, ROCm 10.0 x64, SYCL FP32 x64 tarballs (7) | SHA-256 asset digests in the [release API](https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b11418). The [release](https://github.com/ggml-org/llama.cpp/releases/tag/b11418) also links a [GitHub provenance attestation](https://github.com/ggml-org/llama.cpp/attestations/52850734). No standalone checksum/signature asset was listed. |
| whisper.cpp `v1.9.1` | `whisper-bin-ubuntu-{x64,arm64}.tar.gz` (2) | SHA-256 asset digests in the [release API](https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/v1.9.1). Both Linux assets exist. No separate checksum manifest or binary signature file appeared in its asset list. |
| leaxer-ai/leaxer-stable-diffusion `v0.1.0` | `sd-server-x86_64-unknown-linux-gnu-cuda` and `sd-x86_64-unknown-linux-gnu-cuda` (2) | SHA-256 asset digests in the [release API](https://api.github.com/repos/leaxer-ai/leaxer-stable-diffusion/releases/tags/v0.1.0). No separate checksum manifest or binary signature file appeared in its asset list. This is a third-party build, not a leejet release. |

GitHub documents the release asset [`digest` field](https://docs.github.com/en/rest/releases/assets#get-a-release-asset).
These values are trustworthy **as GitHub-hosted metadata obtained over verified
HTTPS**, under the existing trust in those repositories and GitHub. They are
not independent publisher signatures. Pinning them in the reviewed repository
prevents a later replacement of an upstream asset and its metadata from silently
changing the installed bytes.

The Node pin was obtained from the official HTTPS manifest; the signed version
was inspected, but its PGP signature was not cryptographically verified during
this audit. Setup uses the committed pin and does not fetch keys or manifests.
The llama attestation was identified, not cryptographically verified or matched
to all seven selected assets. A verified Git commit badge does not authenticate
release binaries. Do not describe these checks as signature verification.

## Implementation and failure behavior

- `setup.sh`: Linux Node, SD CPU/Vulkan/ROCm, and both leaxer CUDA downloads
  pass through `download_verified` before archives are exposed for extraction
  or raw executables are made executable and probed with `--help`.
- `setup-llama.sh`: every Linux backend, including optional GPU backends,
  verifies before removing old files or extracting. The optional wrapper no
  longer deletes an old backend after a download/verification failure.
- `setup-whisper.sh`: both Linux architecture downloads verify before extraction.
- `update-llama.sh`: delegates to `setup-llama.sh`, so fresh downloads inherit
  the same checks.
- The source-only `download-verification.sh` looks up one exact URL in
  `linux-downloads.sha256`. Missing, duplicate, malformed, or unknown-release
  entries fail before curl. There is no environment-variable checksum override,
  automatic hash enrollment, or skip-verification switch.
- curl ignores `.curlrc`, requires HTTPS for both the initial request and
  redirects, and writes a `.part` file. A successful SHA-256 comparison is
  required before rename. Failures remove the partial file and return explicitly,
  including inside Bash `if` and `&&` contexts. A missing hash utility fails
  before download; `sha256sum` and `shasum -a 256` are supported.
- Unknown `LLAMA_RELEASE` / `WHISPER_RELEASE` overrides now need reviewed
  manifest additions before fresh downloads can succeed. Required downloads
  fail; optional llama downloads are skipped. Existing cached-backend checks
  still apply.
- This patch does not change release versions, architecture choices, or macOS
  download policy. Node and SD currently select x64 on Linux; adding ARM64
  support is separate work.
- The existing CUDA source-build fallback remains reachable after a prebuilt
  download or checksum failure. The rejected prebuilt is never executed, but
  this is **not** a fail-closed policy for the entire CUDA installation. See below.

## Other Linux acquisition paths and remaining risks

| Path | Current behavior / remaining risk | Proposed stricter alternative (not implemented here) |
| --- | --- | --- |
| `setup.sh` frontend npm install | Tracked `app/frontend/package-lock.json` contains package integrity values, but setup uses `npm install` and permits lifecycle scripts. Native packages or their scripts can obtain additional executables outside these 15 pins. | Require a reviewed lockfile with `npm ci`; audit lifecycle scripts and independently pin any external downloads. Consider `--ignore-scripts` plus explicitly approved build steps, after checking compatibility. |
| `setup-tts.sh` | Creates a runtime package manifest with `kokoro-js: ^1.2.1`; first install resolves without a repository-pinned lockfile. Later `npm ci` uses the local runtime lock. ONNX Runtime's optional CUDA payload is skipped, but native CPU packages and lifecycle scripts remain trusted. | Commit a platform-reviewed lockfile and require `npm ci`; audit native/postinstall fetches or provide a reviewed offline package cache. Fail if the reviewed lock is missing. |
| `setup-openvino-npu.sh` | Upgrades pip and installs unpinned `openvino`, `openvino-genai`, `pillow`, and `huggingface-hub`, then imports installed code. There is no reviewed SHA-256 allowlist for the resolved environment. | Pin the complete transitive wheel set, including pip, with independently obtained registry/publisher hashes and use `--require-hashes --only-binary=:all:`, ideally from a reviewed offline wheelhouse. Until prepared, leave this optional installer disabled or require explicit approval for those exact artifacts. |
| `setup.sh` CUDA source fallback | Clones/fetches stable-diffusion.cpp, checks out a tag, initializes submodules, and runs CMake/build tools. The source, submodules, build dependencies, and toolchain are outside the binary checksum gate. A tag is not an immutable authenticated source pin. | Stop on prebuilt verification failure. Allow a source build only after explicit approval of a full commit, submodule commits, dependency sources and toolchain; build in an isolated environment with an approved output manifest. |
| Existing installations | Node/backend readiness checks can reuse or execute pre-existing files without archive verification. Archives are normally deleted; a release stamp or successful `--help` proves neither origin nor integrity. | Reinstall from verified artifacts or use a separately reviewed installed-file manifest. Do not manufacture trusted expected values from the existing installation. |
| Local and upstream trust | Host curl/hash utilities, the checkout and its pins must be trusted. Checksums cannot detect malicious code already published by a compromised maintainer/build system, library substitution, local file races, or unsafe contents inside an otherwise matching archive. | Protect/review the checkout and updates; verify publisher signatures/attestations and build identity; use isolated extraction/staging and trusted runtime libraries where stronger assurance is required. |

`setup-coreml-npu.sh` and the CoreML/Homebrew branches of the other scripts are
macOS-only, so they introduce no Linux path. The NPU driver URL is guidance for
manual installation, not an automatic download. The new helper performs no
actions when sourced. Windows PowerShell installers, launchers, server-side
in-app backend downloads and model downloads are outside this task's shell-setup
scope and are not covered by this patch.

## When published hashes or stronger provenance are unavailable

All 15 currently selected direct downloads have official-host published
digests. A future release without a valid digest must remain absent from the
manifest and fail closed. Never use a checksum calculated from a newly
downloaded binary as its own expected value.

For SD, whisper, and leaxer, no independent binary-signature evidence was found
in the inspected release assets. If GitHub's unsigned metadata does not meet
the deployment's trust requirements, disable the affected prebuilt path until
the publisher supplies a verifiable signed manifest/attestation. An alternative
is an explicitly approved, isolated build from reviewed immutable source and
dependencies, with a separately reviewed distribution manifest. Accepting
unsigned GitHub metadata should be an explicit trust-policy decision for such
deployments, not an automatic bypass on verification failure.

For future pin updates, review the exact repository, release, filename and
published digest over HTTPS. Prefer Node's signed manifest verified with an
independently trusted release-key fingerprint; for llama, verify the attestation
subject digest and expected repository/workflow/ref before accepting a new pin.
Document any weaker provenance in the same review, update the manifest alongside
the release selection, and run the offline tests. Do not fall back from a failed
signature check to an unsigned checksum.

## Validation

`node --test --test-reporter=spec scripts/tests/download-verification.test.cjs scripts/tests/model-kind.test.cjs scripts/tests/issue-regressions.test.cjs`

50 tests passed, including 19 new offline verification tests. The full suite
needed the existing approved unsandboxed Node test invocation for its archive
fixture regression; the new verification tests also passed inside the sandbox.
Tests use a standard SHA-256 test vector for literal text `abc`, stub curl,
and extract named function definitions without running setup scripts.
They cover all 15 pinned paths, bad/missing/duplicate hashes, unknown releases,
download/hash-tool failures, partial cleanup, HTTPS flags, conditional callers,
preservation of old backends, and blocking extraction/execution consumers.
All `scripts/setup/*.sh` passed `bash -n`; `git diff --check` passed.
