# Security

- [Threat model (STRIDE per component)](threat-model.md)
- [RBAC permission matrix](rbac.md)
- [Security review 2026-10-28 (adversarial pass, findings F1–F7)](review-2026-10-28.md)
- [OWASP Top 10 mapping](owasp-top10.md)
- [Security policy / how to report a vulnerability](../../SECURITY.md)
- ADRs: [0016 authentication](../adr/0016-authentication-jwt-refresh-rotation.md),
  [0017 RBAC](../adr/0017-rbac-model.md), [0018 simulated adapters](../adr/0018-simulated-response-adapters.md),
  [0022 dependency pinning](../adr/0022-dependency-pinning-and-version-policy.md),
  [0024 API edge controls](../adr/0024-api-conventions.md)

## Security principles applied in Spine

1. **Validate at every trust boundary.** Zod schemas on every request, response, event and config value.
2. **Deny by default.** Routes without a declared policy can't be registered.
3. **Least privilege.** Three roles, minimum role per route; admin-only for anything that changes how the SOC responds.
4. **Defence in depth.** App-level checks, plus DB-level constraints (append-only audit trigger,
   CHECK constraints, unique indexes), plus proxy-level headers and TLS.
5. **Secure defaults.** `COOKIE_SECURE=true`, API docs off in production, placeholder secrets rejected in production.
6. **No real side effects.** Response adapters are simulated by design.

## Verifying a release

Released images are signed keylessly with Sigstore cosign and carry SLSA build provenance
([ADR-0099](../adr/0099-supply-chain-pinning-signing-provenance.md)). To check that an image was
built by this repository's release workflow:

```bash
cosign verify ghcr.io/abdoukh4-art/spine-api:0.1.0 \
  --certificate-identity 'https://github.com/abdoukh4-art/spine/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/abdoukh4-art/spine-api:0.1.0 --repo abdoukh4-art/spine
```

Use the same commands for `spine-console`. These workflows run on the first release after `develop`
is merged into `main`; until then there is nothing to verify.
