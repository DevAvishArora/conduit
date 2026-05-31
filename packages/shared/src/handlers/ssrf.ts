import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

/**
 * SSRF hardening for worker egress (§7.1.3).
 *  - block private / loopback / link-local / CGNAT ranges by default
 *  - validate the resolved IP at CONNECT time, not parse time, which closes
 *    the DNS-rebinding hole (resolve→validate→connect by the validated IP).
 *  - optional per-tenant allowlist of hostnames.
 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true; // unparseable -> block
}

function isBlockedV4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true;
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = lc.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  if (lc.startsWith("fe8") || lc.startsWith("fe9") || lc.startsWith("fea") || lc.startsWith("feb"))
    return true; // fe80::/10 link-local
  if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // fc00::/7 ULA
  return false;
}

export class SsrfBlockedError extends Error {}

/** Validate scheme + allowlist before we even resolve DNS. */
export function assertUrlAllowed(rawUrl: string, allowlist: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid url: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new SsrfBlockedError(`blocked scheme: ${url.protocol}`);
  if (allowlist.length > 0) {
    const host = url.hostname.toLowerCase();
    const ok = allowlist.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) throw new SsrfBlockedError(`host not in allowlist: ${host}`);
  }
  return url;
}

/**
 * A `lookup` for http(s).request that resolves DNS then rejects the connection
 * if the chosen address is in a blocked range. Because http core connects to
 * exactly the address handed back here, a rebind between resolve and connect
 * cannot smuggle a private IP through.
 */
export function validatingLookup(blockPrivate: boolean): typeof dnsLookup {
  // Node's http/https calls this in TWO shapes:
  //   - { all: false } → callback(err, addressString, family)
  //   - { all: true  } → callback(err, [{ address, family }, ...])
  // We must preserve whichever shape the caller asked for; collapsing the
  // array form to a single string breaks net.emitLookup with ERR_INVALID_IP_ADDRESS.
  const fn = ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      ...rest: unknown[]
    ) => void;
    const opts = (typeof options === "function" ? {} : (options ?? {})) as Record<string, unknown>;

    dnsLookup(hostname, opts as object, (err, address, family) => {
      if (err) return cb(err);

      if (Array.isArray(address)) {
        if (blockPrivate) {
          for (const a of address as Array<{ address: string }>) {
            if (isBlockedIp(a.address)) {
              return cb(
                new SsrfBlockedError(`blocked private address ${a.address} for ${hostname}`),
              );
            }
          }
        }
        return cb(null, address);
      }

      if (typeof address !== "string") {
        return cb(new Error(`dns lookup returned no address for ${hostname}`));
      }
      if (blockPrivate && isBlockedIp(address)) {
        return cb(new SsrfBlockedError(`blocked private address ${address} for ${hostname}`));
      }
      cb(null, address, family);
    });
  }) as typeof dnsLookup;
  return fn;
}
