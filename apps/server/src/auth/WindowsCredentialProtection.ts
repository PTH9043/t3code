import { createRequire } from "node:module";

const ENVELOPE = new TextEncoder().encode("T3-DPAPI-V1\0");
const ENTROPY_PREFIX = "T3 credential:";
const require = createRequire(import.meta.url);

function windowsDpapi(): typeof import("@primno/dpapi").Dpapi {
  if (process.platform !== "win32")
    throw new Error("Windows credential protection is unavailable.");
  const module = require("@primno/dpapi") as typeof import("@primno/dpapi");
  if (!module.isPlatformSupported) throw new Error("Windows credential protection is unavailable.");
  return module.Dpapi;
}

const PROTECTED_CREDENTIAL_PREFIXES = ["provider-env-", "google-oauth-", "drive_backup_"] as const;

const PROTECTED_CREDENTIAL_EXACT_NAMES = new Set<string>([
  "google-login-account",
  "google-login-accounts",
]);

export function isProtectedCredentialName(name: string): boolean {
  if (PROTECTED_CREDENTIAL_EXACT_NAMES.has(name)) {
    return true;
  }
  return PROTECTED_CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isWindowsProtectedCredential(value: Uint8Array): boolean {
  return value.length >= ENVELOPE.length && ENVELOPE.every((byte, index) => value[index] === byte);
}

export function isPlausibleLegacyCredential(value: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    return !text.includes("\0");
  } catch {
    return false;
  }
}

function entropy(name: string): Uint8Array {
  return new TextEncoder().encode(`${ENTROPY_PREFIX}${name}`);
}

export function protectWindowsCredential(name: string, value: Uint8Array): Uint8Array {
  const dpapi = windowsDpapi();
  const encrypted = dpapi.protectData(value, entropy(name), "CurrentUser");
  const verified = dpapi.unprotectData(encrypted, entropy(name), "CurrentUser");
  if (verified.length !== value.length || !verified.every((byte, index) => byte === value[index])) {
    throw new Error("Windows credential encryption verification failed.");
  }
  const envelope = new Uint8Array(ENVELOPE.length + encrypted.length);
  envelope.set(ENVELOPE);
  envelope.set(encrypted, ENVELOPE.length);
  return envelope;
}

export function unprotectWindowsCredential(name: string, value: Uint8Array): Uint8Array {
  if (!isWindowsProtectedCredential(value))
    throw new Error("Invalid encrypted credential envelope.");
  return windowsDpapi().unprotectData(
    value.subarray(ENVELOPE.length),
    entropy(name),
    "CurrentUser",
  );
}
