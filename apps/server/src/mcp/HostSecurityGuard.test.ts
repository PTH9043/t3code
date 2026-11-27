import { describe, expect, it } from "vite-plus/test";
import { scrubSecretsFromText, validatePreviewNavigationUrl } from "./HostSecurityGuard.ts";

describe("HostSecurityGuard", () => {
  it("blocks cloud metadata, private LAN ranges, IPv4-mapped IPv6, obfuscated IPs, and non-HTTP schemes", () => {
    const blockedUrls = [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://10.0.0.1/admin",
      "http://192.168.1.10/",
      "http://172.16.5.2/",
      "http://[::ffff:169.254.169.254]/",
      "http://0xa9fea9fe/",
      "file:///C:/Windows/System32/drivers/etc/hosts",
      "javascript:alert(1)",
    ];
    for (const url of blockedUrls) {
      const result = validatePreviewNavigationUrl(url, { allowLocalhost: true });
      expect(result.allowed, url).toBe(false);
    }

    // Loopback blocked when allowLocalhost=false or port not whitelisted
    expect(
      validatePreviewNavigationUrl("http://127.0.0.1:5733/", { allowLocalhost: false }).allowed,
    ).toBe(false);
    expect(
      validatePreviewNavigationUrl("http://0x7f000001:5733/", { allowLocalhost: false }).allowed,
    ).toBe(false);
    expect(
      validatePreviewNavigationUrl("http://localhost:8080/", {
        allowLocalhost: true,
        allowedLocalhostPorts: [5733, 13773],
      }).allowed,
    ).toBe(false);
    expect(
      validatePreviewNavigationUrl("http://localhost:5733/", {
        allowLocalhost: true,
        allowedLocalhostPorts: [5733, 13773],
      }).allowed,
    ).toBe(true);
    expect(validatePreviewNavigationUrl("https://docs.example.com/guide").allowed).toBe(true);
  });

  it("scrubs known secrets and common API credential tokens from error strings", () => {
    const raw =
      "Request failed with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc and key sk-or-v1-1234567890abcdef1234567890 and custom_secret_token_99";
    const cleaned = scrubSecretsFromText(raw, ["custom_secret_token_99"]);
    expect(cleaned).not.toContain("eyJhbGciOiJIUzI1Ni");
    expect(cleaned).not.toContain("sk-or-v1-1234567890");
    expect(cleaned).not.toContain("custom_secret_token_99");
    expect(cleaned).toContain("[REDACTED]");
  });
});
