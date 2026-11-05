// Minimal container healthcheck for shell-less (distroless) images.
// Usage: node /app/healthcheck.mjs http://127.0.0.1:3000/healthz
// Exit 0 when the URL answers 2xx within 3 s, 1 otherwise. No dependencies.
const url = process.argv[2] ?? 'http://127.0.0.1:3000/healthz';
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
