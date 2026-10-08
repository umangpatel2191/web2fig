/**
 * Safety rules for the hosted helper: it must never be talked into reaching private networks
 * (the host's internal services, cloud metadata addresses, other machines on its network).
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd)/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true; // not an IP at all: treat as unsafe
}

const hostCache = new Map<string, { ok: boolean; at: number }>();

/** Throws unless the URL is http(s) on a public address (and, hosted, a normal web port). */
export async function assertPublicUrl(raw: string): Promise<void> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links can be captured.');
  if (u.username || u.password) throw new Error('Links with a user name or password are not allowed.');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (!['80', '443', '8080', '8443'].includes(port)) throw new Error('That port is not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < 60_000) {
    if (!cached.ok) throw new Error('That address is not allowed (private network).');
    return;
  }
  let ok = true;
  if (net.isIP(host)) ok = !isPrivateAddress(host);
  else {
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) ok = false;
    else {
      try {
        const addrs = await dns.lookup(host, { all: true });
        ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
      } catch {
        ok = false;
      }
    }
  }
  hostCache.set(host, { ok, at: Date.now() });
  if (hostCache.size > 2000) hostCache.clear();
  if (!ok) throw new Error('That address is not allowed (private network or unknown host).');
}
