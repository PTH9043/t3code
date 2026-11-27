import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { addFbjniVersionPin, FBJNI_VERSION } = require("./withAndroidFbjniVersion.cjs") as {
  addFbjniVersionPin: (contents: string) => string;
  FBJNI_VERSION: string;
};

describe("Android fbjni compatibility", () => {
  it("pins the version used by the installed React Native runtime", () => {
    const reactNativePackage = require.resolve("react-native/package.json");
    const catalog = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(reactNativePackage), "gradle", "libs.versions.toml"),
      "utf8",
    );
    expect(catalog).toContain(`fbjni = "${FBJNI_VERSION}"`);
    expect(addFbjniVersionPin("allprojects {}\n")).toContain(
      `resolutionStrategy.force 'com.facebook.fbjni:fbjni:${FBJNI_VERSION}'`,
    );
  });

  it("does not add a duplicate pin on repeated prebuilds", () => {
    const once = addFbjniVersionPin("allprojects {}\n");
    expect(addFbjniVersionPin(once)).toBe(once);
  });
});
