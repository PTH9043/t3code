import { describe, expect, it } from "vite-plus/test";
import { findEnrolledGoogleAccount, type EnrolledGoogleAccount } from "./GoogleAccountAuth.ts";

describe("GoogleAccountAuth multi-account matching", () => {
  const accounts: ReadonlyArray<EnrolledGoogleAccount> = [
    {
      clientId: "cid-shared",
      subject: "sub-ultra",
      email: "ultra@example.com",
      tier: "ultra",
      driveBackupLinked: true,
      scopes: ["orchestration:read", "orchestration:operate"],
      isDefault: true,
    },
    {
      clientId: "cid-shared",
      subject: "sub-pro",
      email: "pro@example.com",
      tier: "pro",
      driveBackupLinked: false,
      scopes: ["orchestration:read"],
      isDefault: false,
    },
  ];

  it("matches each enrolled account by (clientId, subject) and rejects unknown pairs", () => {
    expect(findEnrolledGoogleAccount(accounts, "cid-shared", "sub-ultra")?.email).toBe(
      "ultra@example.com",
    );
    expect(findEnrolledGoogleAccount(accounts, "cid-shared", "sub-pro")?.tier).toBe("pro");
    expect(findEnrolledGoogleAccount(accounts, "cid-wrong", "sub-ultra")).toBeNull();
    expect(findEnrolledGoogleAccount(accounts, "cid-shared", "sub-unknown")).toBeNull();
  });
});
