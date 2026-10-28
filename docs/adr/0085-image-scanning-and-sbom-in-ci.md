# ADR-0085: Scan container images with Trivy and publish image SBOMs in CI

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** infra + observability workstream
- **Tags:** security, process

## Context and problem statement

`pnpm audit` (ADR-0028) only sees npm packages. A container image also carries OS
packages (OpenSSL, libc, busybox) that age independently of our lockfile. The first scan
of our own images proved the point: 7 fixable HIGH/CRITICAL OpenSSL findings in the
Debian 12 distroless base and 72 in a stale nginx base from a registry mirror, with zero
npm findings.

## Decision drivers

- Fail the build on vulnerabilities we can fix, not on ones nobody can fix yet.
- Know exactly what ships (SBOM), for incident response ("are we affected by CVE-X?").
- CI actions are themselves supply chain.

## Considered options

1. **Trivy (`aquasecurity/trivy-action` pinned by commit SHA): fail on HIGH/CRITICAL with
   `ignore-unfixed`, plus a CycloneDX image SBOM artifact**
2. Grype + Syft
3. Docker Scout
4. Scan only on a weekly schedule

## Decision outcome

**Chosen option 1.** The `docker-build-scan` job in `.github/workflows/security.yml`
builds both images (matrix `api`, `console`, GitHub Actions layer cache), generates a
CycloneDX SBOM per image (uploaded as an artifact even when the scan fails), then runs the
vulnerability scan with `--severity CRITICAL,HIGH --ignore-unfixed --exit-code 1`. It runs
on every PR, on pushes to `main`/`develop`, and weekly (new CVEs appear in unchanged images).

Supporting rules:

- Third-party actions are pinned to a **full commit SHA** with the version in a comment.
  Tags can be moved; a SHA can't.
- Base images are refreshed rather than suppressed: Debian 13 distroless for the API, and
  `apk upgrade` in the console image (registry mirrors can serve months-old Alpine
  layers). `APK_UPGRADE=false` exists only for builds that cannot reach the Alpine CDN,
  and such images will fail the scan (that's intended: they're for local use).
- No `.trivyignore` today. If one is ever needed, each entry needs a justification and an
  expiry date in the same line.

### Consequences

- 👍 A PR cannot introduce a fixable HIGH/CRITICAL in an image; the weekly run catches
  CVEs published after merge.
- 👍 SBOMs answer "where do we ship package X?" in seconds.
- 👎 A newly published fix can turn `main` red without any code change (that is the point,
  but it costs a rebuild-and-bump PR).
- 👎 Builds both images on every PR (~2–3 min with cache).

## Pros and cons of the options

### Grype + Syft

- 👍 Excellent, also widely used.
- 👎 Two tools; the repo-level SBOM job already uses Anchore's action, Trivy gives the
  image scan and image SBOM in one place.

### Docker Scout

- 👎 Requires a Docker account in CI; less transparent policy.

### Weekly only

- 👎 Feedback after merge instead of before.

## What would make us revisit this

- Images are published to a registry → sign them (cosign) and attach the SBOM as an attestation.
- `ignore-unfixed` hides a serious unfixed issue we must mitigate → add a documented exception process.

## Further reading

- Aqua Security, _Trivy_ documentation; OWASP, _CycloneDX_ specification
- GitHub docs, _Security hardening for GitHub Actions_ (pinning actions to a full-length commit SHA)
- CISA, _SBOM_ resources
