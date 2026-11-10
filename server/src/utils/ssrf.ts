import { promises as dns } from 'dns';
import { isIP } from 'net';

/**
 * Guard for URLs our servers will call on a customer's behalf (a firm's own AI
 * provider): HTTPS only, and every address the host resolves to must be public.
 * Blocks loopback, private (RFC 1918, ULA), link-local (incl. the cloud metadata
 * address 169.254.169.254), CGNAT, multicast and other reserved ranges. Called
 * when the URL is saved and again before each use, so a DNS change cannot point
 * it inside our network later.
 */

export class UnsafeUrlError extends Error {}

function ipv4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || // 192.0.0.0/24, 192.0.2.0/24 documentation
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // documentation
    (a === 203 && b === 0) || // documentation
    a >= 224 // multicast and reserved
  );
}

function ipv6Blocked(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Blocked(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith('2001:db8') || v.startsWith('64:ff9b');
}

export const isBlockedAddress = (ip: string): boolean => (isIP(ip) === 6 ? ipv6Blocked(ip) : ipv4Blocked(ip));

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('The URL is not valid.');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('Only https:// URLs are allowed.');
  if (url.username || url.password) throw new UnsafeUrlError('The URL must not contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeUrlError('Internal host names are not allowed.');
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new UnsafeUrlError(`The host ${host} could not be resolved.`);
    }
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new UnsafeUrlError(`The host ${host} resolves to a private or reserved address.`);
  }
  return url;
}
