# ADR-0099: Pin actions by SHA, sign released images keylessly, attest provenance, publish a Scorecard

- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** maintainers
- **Tags:** security, ci, supply-chain

## Context and problem statement

Spine already scans what it builds: CodeQL, gitleaks, `pnpm audit`, Trivy on both images and SBOMs
(ADR-0085). That protects _users of the code_. It doesn't let a user who **runs the images** answer two
questions: "did this image come from Spine's CI, built from this commit?" and "has anything in the
build pipeline been swapped?". The 2020s' biggest supply-chain incidents (a compromised build step,
a re-tagged action) attacked exactly those questions.

## Decision drivers

- Verifiable by anyone with standard, free tools, without managing signing keys.
- Every CI dependency fixed by content, not by a movable tag.
- Measured by an external, standard score instead of our own claim.
- Nothing outward-facing runs without the owner's action (merge to `main`, release).

## Considered options

1. **Pin every action to a commit SHA (enforced), sign images keylessly with Sigstore cosign, attach
   SLSA build provenance with GitHub artifact attestations, publish an OpenSSF Scorecard.**
2. Sign with a long-lived cosign key stored as a repository secret.
3. Pin to major tags (`@v4`) and rely on GitHub's tag immutability.
4. A SLSA level 3 reusable workflow (slsa-framework generators) instead of GitHub attestations.

## Decision outcome

**Option 1.**

- **Pinning:** all 48 action references are pinned to full commit SHAs, each with a `# vX.Y.Z`
  comment (the newest release in the major already in use). `scripts/check-workflows.mjs` (CI lint
  job, `make check`) fails on any unpinned `uses:`, a missing top-level `permissions`, a `needs` that
  names no job, or an undeclared `needs.<job>.outputs.<name>`. Dependabot's `github-actions`
  ecosystem keeps the SHAs current.
- **Release images** (`release.yml`, only when release-please creates a release on `main`): build
  `ghcr.io/<owner>/spine-api` and `spine-console` with the CI build arguments, push, then:
  - **provenance:** `actions/attest-build-provenance` signs an in-toto SLSA provenance statement
    (builder, workflow, commit, inputs) and pushes it next to the image;
  - **signature:** `cosign sign` by digest, keyless: the certificate is bound to this workflow's
    OIDC identity and logged in the public Rekor transparency log.
  - Least privilege per job: `packages: write`, `id-token: write`, `attestations: write` exist
    only on the publish job; the workflow default is `contents: read`.
- **Scorecard** (`scorecard.yml`): weekly and on pushes to `main`; results go to code scanning (SARIF)
  and are published to the OpenSSF API for the README badge.

**Verify a release** (also in [security/README.md](../security/README.md)):

```bash
cosign verify ghcr.io/abdoukh4-art/spine-api:0.1.0 \
  --certificate-identity 'https://github.com/abdoukh4-art/spine/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/abdoukh4-art/spine-api:0.1.0 --repo abdoukh4-art/spine
```

Option 2 creates a secret that can leak and must be rotated; keyless signing ties the signature to
_which workflow ran_, which is the claim users care about. Option 3: tags can be moved by whoever
controls the action's repository. Option 4 gives stronger isolation (SLSA L3), but GitHub's
attestations are verifiable with `gh` alone and reach SLSA build L2 with no extra infrastructure.

### Consequences

- 👍 A user can check, offline-capable and keylessly, that an image came from this repository's
  release workflow at a given commit.
- 👍 A re-tagged or compromised upstream action can't silently change what CI runs.
- 👎 **Not exercised yet.** The publish job and Scorecard run only on `main`, which the owner hasn't
  merged. `ci.yml`/`security.yml` with the pinned SHAs _are_ exercised on every PR; the two new
  workflows were checked structurally (`check-workflows.mjs`), not run. The first release will be
  their real test.
- 👎 Images become public packages on GHCR when the first release is published; the owner decides.
- ⚖️ Scorecard will flag what a solo project can't fully satisfy (e.g. code review by a second
  person, branch protection until the owner enables it). The score is a signal, not a target.

## What would make us revisit this

- A consumer requires SLSA build L3 → move image builds to the SLSA reusable workflow.
- The project gains maintainers → require signed commits and two-person review (Scorecard checks).
- Images move to another registry → the verify commands and identity change; update this ADR.

## Further reading

- SLSA v1.0 specification (build track); Sigstore cosign keyless signing; GitHub artifact attestations
- OpenSSF Scorecard checks documentation (Pinned-Dependencies, Token-Permissions, Signed-Releases)
