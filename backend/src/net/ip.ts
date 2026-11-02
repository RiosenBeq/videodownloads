/**
 * Classification of IP addresses for SSRF protection. Anything that is not a
 * globally routable unicast address is considered non-public.
 */
import net from 'node:net';

const blockedV4 = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blockedV4.addSubnet(prefix, bits, 'ipv4');
}

const blockedV6 = new net.BlockList();
for (const [prefix, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (incl. Teredo)
  ['2001:db8::', 32], // documentation
  ['64:ff9b:1::', 48], // local-use NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const) {
  blockedV6.addSubnet(prefix, bits, 'ipv6');
}

/** Expand an IPv6 address to eight 16-bit groups. Returns null if malformed. */
export function expandIpv6(address: string): number[] | null {
  let addr = address.split('%')[0].toLowerCase();
  // Embedded dotted IPv4 tail, e.g. ::ffff:127.0.0.1
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Tail) {
    const parts = v4Tail[1].split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    addr = addr.slice(0, -v4Tail[1].length) + `${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** IPv4 address embedded in an IPv6 address (mapped, compatible, NAT64, 6to4). */
export function embeddedIpv4(address: string): string | null {
  const g = expandIpv6(address);
  if (!g) return null;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4FromGroups(g[6], g[7]); // ::ffff:a.b.c.d
  if (zero(0, 6) && (g[6] !== 0 || g[7] > 1)) return v4FromGroups(g[6], g[7]); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4FromGroups(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return v4FromGroups(g[1], g[2]); // 6to4
  return null;
}

export function isPublicAddress(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, '');
  const family = net.isIP(clean.split('%')[0]);
  if (family === 4) return !blockedV4.check(clean, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(clean);
    if (v4) return isPublicAddress(v4);
    return !blockedV6.check(clean.split('%')[0], 'ipv6');
  }
  return false;
}

export function isLoopbackAddress(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  return clean === '::1' || /^127\./.test(clean);
}
