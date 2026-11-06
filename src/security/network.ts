import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";

/** Loopback, private, link-local, CGNAT, metadata, multicast and reserved ranges. */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

const BLOCKED_HOSTNAMES =
  /^(localhost|metadata\.google\.internal|metadata)$|\.localhost$|\.internal$/i;

/** Extracts the IPv4 address embedded in an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:7f00:1). */
function mappedIpv4(address: string): string | null {
  const match = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(address);
  const tail = match?.[1];
  if (tail === undefined) return null;
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (hex === null) return null;
  const high = Number.parseInt(hex[1] ?? "0", 16);
  const low = Number.parseInt(hex[2] ?? "0", 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** True when the IP literal points at a non-public network. Non-IP input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, "ipv4");
  if (family === 6) {
    const v4 = mappedIpv4(bare);
    return v4 !== null ? BLOCKED.check(v4, "ipv4") : BLOCKED.check(bare, "ipv6");
  }
  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host) !== 0) return isBlockedAddress(host);
  return BLOCKED_HOSTNAMES.test(host);
}

export class BlockedAddressError extends Error {
  readonly code = "EBLOCKEDADDRESS";

  constructor(host: string, address: string) {
    super(
      `refusing to connect to ${host} (${address}): private, loopback, link-local and metadata addresses are blocked`,
    );
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A dns.lookup replacement for http.request that validates every resolved
 * address at connect time, so DNS rebinding cannot slip past an earlier check.
 */
export function safeLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, []);
      return;
    }
    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    if (blocked !== undefined) {
      callback(new BlockedAddressError(hostname, blocked.address), []);
      return;
    }
    if (options.all === true) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    if (first === undefined) {
      callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), []);
      return;
    }
    callback(null, first.address, first.family);
  });
}
