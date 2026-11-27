/**
 * Host Control-Plane Security Guards (adapted from BotRoster invariants):
 * 1) Strict SSRF guard blocking cloud metadata endpoints, private LAN ranges,
 *    IPv4-mapped IPv6, octal/hex/decimal-integer IP obfuscation, and non-HTTP schemes.
 * 2) Secret scrubber ensuring API keys/tokens never leak back through MCP diagnostics.
 */

const BLOCKED_EXACT_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
]);

function parseIpv4Octets(hostname: string): readonly [number, number, number, number] | null {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:7f00:1
  const mappedDotted = clean.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    return parseIpv4Octets(mappedDotted[1]!);
  }
  const mappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }

  // Single-integer / hex IPv4 (e.g. 2130706433 or 0x7f000001)
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(clean)) {
    const num = clean.startsWith("0x")
      ? Number.parseInt(clean, 16)
      : clean.startsWith("0") && clean.length > 1
        ? Number.parseInt(clean, 8)
        : Number.parseInt(clean, 10);
    if (Number.isFinite(num) && num >= 0 && num <= 0xffffffff) {
      return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff];
    }
  }

  // Dotted quad (allowing octal/hex segments)
  const parts = clean.split(".");
  if (parts.length === 4 && parts.every((part) => /^(?:0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(part))) {
    const nums = parts.map((part) =>
      part.startsWith("0x")
        ? Number.parseInt(part, 16)
        : part.startsWith("0") && part.length > 1
          ? Number.parseInt(part, 8)
          : Number.parseInt(part, 10),
    );
    if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
    }
  }

  return null;
}

function isLoopbackHost(
  hostname: string,
  ipv4: readonly [number, number, number, number] | null,
): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    clean === "localhost" ||
    clean.endsWith(".localhost") ||
    clean === "::1" ||
    clean === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  return ipv4 !== null && ipv4[0] === 127;
}

function isPrivateOrMetadataIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local & cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!clean.includes(":")) return false;
  return (
    clean === "::" ||
    clean.startsWith("fc") ||
    clean.startsWith("fd") ||
    clean.startsWith("fe80:") ||
    clean.startsWith("fe9") ||
    clean.startsWith("fea") ||
    clean.startsWith("feb")
  );
}

export interface SsrfValidationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function validatePreviewNavigationUrl(
  rawUrl: string,
  options?: {
    /** Local dev servers on localhost/127.0.0.1 are permitted unless explicitly disabled. */
    readonly allowLocalhost?: boolean;
    readonly allowedLocalhostPorts?: ReadonlyArray<number>;
  },
): SsrfValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Invalid URL syntax." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Disallowed URL protocol '${parsed.protocol}'.` };
  }

  const hostLower = parsed.hostname.toLowerCase();
  const bareHost = hostLower.replace(/^\[|\]$/g, "");
  if (BLOCKED_EXACT_HOSTS.has(bareHost)) {
    return { allowed: false, reason: `Cloud metadata host '${bareHost}' is blocked.` };
  }

  const ipv4 = parseIpv4Octets(hostLower);
  if (isLoopbackHost(hostLower, ipv4)) {
    if (options?.allowLocalhost === false) {
      return { allowed: false, reason: "Loopback navigation is disabled by host policy." };
    }
    if (options?.allowedLocalhostPorts && options.allowedLocalhostPorts.length > 0) {
      const effectivePort = parsed.port
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "https:"
          ? 443
          : 80;
      if (!options.allowedLocalhostPorts.includes(effectivePort)) {
        return {
          allowed: false,
          reason: `Loopback port ${effectivePort} is not in allowedLocalhostPorts.`,
        };
      }
    }
    return { allowed: true };
  }

  if (ipv4 && isPrivateOrMetadataIpv4(ipv4)) {
    return { allowed: false, reason: `Private or link-local IPv4 '${ipv4.join(".")}' is blocked.` };
  }
  if (isPrivateIpv6(hostLower)) {
    return { allowed: false, reason: `Private or link-local IPv6 '${bareHost}' is blocked.` };
  }

  return { allowed: true };
}

const GENERIC_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bxai-[A-Za-z0-9_-]{16,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
];

/**
 * Scrubs both known secret values and common API credential patterns from
 * outbound diagnostic/error strings before returning them to guest agents.
 */
export function scrubSecretsFromText(text: string, knownSecrets?: ReadonlyArray<string>): string {
  let scrubbed = text;
  if (knownSecrets) {
    for (const secret of knownSecrets) {
      if (secret && secret.length >= 6) {
        scrubbed = scrubbed.split(secret).join("[REDACTED]");
      }
    }
  }
  for (const pattern of GENERIC_SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && /^Bearer\s+/i.test(prefix)
        ? `${prefix}[REDACTED]`
        : "[REDACTED]",
    );
  }
  return scrubbed;
}
