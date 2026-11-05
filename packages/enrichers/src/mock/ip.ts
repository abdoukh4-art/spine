/**
 * True for addresses that only make sense inside an organization: RFC 1918 (10/8,
 * 172.16/12, 192.168/16), loopback, link-local, and IPv6 unique-local (fc00::/7),
 * link-local (fe80::/10) and loopback. Internet reputation and geo databases know nothing
 * about them, while the asset inventory knows *only* them.
 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
