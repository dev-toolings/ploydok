// SPDX-License-Identifier: AGPL-3.0-only
import { BlockList, isIP } from "node:net"

// Published Cloudflare proxy ranges, verified 2026-10-15. These identify an
// indeterminate proxy destination, never ownership or permission to route.
// Sources: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
const ranges = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32",
  "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
]
const proxies = new BlockList()
for (const range of ranges) {
  const [address, prefix] = range.split("/")
  proxies.addSubnet(address!, Number(prefix), isIP(address!) === 6 ? "ipv6" : "ipv4")
}

export function isCloudflareProxyAddress(address: string): boolean {
  const family = isIP(address)
  return family !== 0 && proxies.check(address, family === 6 ? "ipv6" : "ipv4")
}
