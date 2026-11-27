// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  isProtectedCredentialName,
  isWindowsProtectedCredential,
} from "./WindowsCredentialProtection.ts";

describe("WindowsCredentialProtection (5단계 DPAPI 보호 범위 확장 및 자동 이행)", () => {
  it("protects provider-env, google-oauth, google-login-accounts, and drive_backup credentials while excluding binary random keys", () => {
    expect(isProtectedCredentialName("provider-env-openai")).toBe(true);
    expect(isProtectedCredentialName("google-oauth-client-secret")).toBe(true);
    expect(isProtectedCredentialName("google-oauth-app-config")).toBe(true);
    expect(isProtectedCredentialName("google-login-account")).toBe(true);
    expect(isProtectedCredentialName("google-login-accounts")).toBe(true);
    expect(isProtectedCredentialName("drive_backup_passphrase")).toBe(true);
    expect(isProtectedCredentialName("drive_backup_gdrive_oauth")).toBe(true);
    expect(isProtectedCredentialName("drive_backup_gdrive_oauth_sub_12345")).toBe(true);

    // Random binary secrets must remain untouched
    expect(isProtectedCredentialName("session-signing-key")).toBe(false);
    expect(isProtectedCredentialName("pairing-token-secret")).toBe(false);
    expect(isProtectedCredentialName("other-binary-key")).toBe(false);
  });

  it("migrates legacy plaintext OAuth and Drive backup .bin files to Windows DPAPI envelope on boot and encrypts new writes", async () => {
    const tmpRoot = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-dpapi-stage5-"));
    try {
      const secretsDir = NodePath.join(tmpRoot, "userdata", "secrets");
      NodeFs.mkdirSync(secretsDir, { recursive: true });

      const legacyFixtures: ReadonlyArray<readonly [string, string]> = [
        [
          "google-oauth-app-config",
          '{"clientId":"cid-test.apps.googleusercontent.com","clientSecret":"GOCSPX-legacy-secret"}',
        ],
        [
          "google-login-accounts",
          '[{"subject":"sub-1","email":"legacy@example.com","isDefault":true}]',
        ],
        [
          "drive_backup_gdrive_oauth",
          '{"clientId":"cid","clientSecret":"GOCSPX-drive-sec","refreshToken":"1//legacy-refresh-token"}',
        ],
        ["drive_backup_passphrase", "my-very-secret-backup-passphrase"],
      ];

      for (const [name, plaintext] of legacyFixtures) {
        NodeFs.writeFileSync(
          NodePath.join(secretsDir, `${name}.bin`),
          Buffer.from(plaintext, "utf8"),
        );
      }

      const binaryNonProtected = Uint8Array.from([0x00, 0xff, 0x10, 0x00, 0xab, 0xcd]);
      NodeFs.writeFileSync(
        NodePath.join(secretsDir, "session-signing-key.bin"),
        binaryNonProtected,
      );

      const configLayer = ServerConfig.layerTest(tmpRoot, tmpRoot);
      const storeLayer = ServerSecretStore.layer.pipe(
        Layer.provide(configLayer),
        Layer.provide(Layer.succeed(HostProcessPlatform, process.platform)),
        Layer.provide(NodeServices.layer),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ServerSecretStore.ServerSecretStore;

          // 1. All legacy files must decrypt back to their exact original UTF-8 text
          for (const [name, expectedPlaintext] of legacyFixtures) {
            const loaded = yield* store.get(name);
            expect(Option.isSome(loaded)).toBe(true);
            if (Option.isSome(loaded)) {
              expect(new TextDecoder().decode(loaded.value)).toBe(expectedPlaintext);
            }
          }

          // 2. Write a brand-new per-subject Drive OAuth token
          const newSecretText =
            '{"clientId":"cid2","clientSecret":"GOCSPX-new","refreshToken":"1//new-tok"}';
          yield* store.set(
            "drive_backup_gdrive_oauth_sub_new",
            new TextEncoder().encode(newSecretText),
          );
          const loadedNew = yield* store.get("drive_backup_gdrive_oauth_sub_new");
          expect(Option.isSome(loadedNew)).toBe(true);
          if (Option.isSome(loadedNew)) {
            expect(new TextDecoder().decode(loadedNew.value)).toBe(newSecretText);
          }

          // 3. Unprotected binary secret stays intact
          const loadedBin = yield* store.get("session-signing-key");
          expect(Option.isSome(loadedBin)).toBe(true);
          if (Option.isSome(loadedBin)) {
            expect(Array.from(loadedBin.value)).toEqual(Array.from(binaryNonProtected));
          }
        }).pipe(Effect.provide(storeLayer)),
      );

      // 4. Verify on-disk bytes after boot migration & new write
      if (process.platform === "win32") {
        for (const [name, expectedPlaintext] of [
          ...legacyFixtures,
          [
            "drive_backup_gdrive_oauth_sub_new",
            '{"clientId":"cid2","clientSecret":"GOCSPX-new","refreshToken":"1//new-tok"}',
          ] as const,
        ]) {
          const rawOnDisk = NodeFs.readFileSync(NodePath.join(secretsDir, `${name}.bin`));
          expect(isWindowsProtectedCredential(rawOnDisk)).toBe(true);
          // Plaintext secret material must not appear anywhere on disk
          expect(rawOnDisk.toString("utf8")).not.toContain(expectedPlaintext);
        }
        expect(
          rawOnDiskNotContains(secretsDir, "drive_backup_gdrive_oauth", "1//legacy-refresh-token"),
        ).toBe(true);
        expect(
          rawOnDiskNotContains(secretsDir, "google-oauth-app-config", "GOCSPX-legacy-secret"),
        ).toBe(true);
      }

      const rawNonProtected = NodeFs.readFileSync(
        NodePath.join(secretsDir, "session-signing-key.bin"),
      );
      expect(isWindowsProtectedCredential(rawNonProtected)).toBe(false);
      expect(Array.from(rawNonProtected)).toEqual(Array.from(binaryNonProtected));
    } finally {
      NodeFs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

function rawOnDiskNotContains(secretsDir: string, name: string, secretFragment: string): boolean {
  const bytes = NodeFs.readFileSync(NodePath.join(secretsDir, `${name}.bin`));
  return !bytes.toString("utf8").includes(secretFragment);
}
