import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  ASSET_ROUTE_PREFIX,
  issueAssetUrl,
  resolveAsset,
  resolveRegisteredWorkspaceRootForAssetPath,
} from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("AssetAccess", () => {
  it.effect(
    "downloads non-preview files with an exact capability and preserves the file name",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-asset-download-" });
        const fileName = "한글 자료.zip";
        const archivePath = path.join(root, fileName);
        yield* fileSystem.writeFile(archivePath, new Uint8Array([80, 75, 3, 4, 0, 255]));
        yield* fileSystem.writeFileString(path.join(root, "sibling.txt"), "private sibling");
        const resource = {
          _tag: "workspace-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: archivePath,
        };
        const previewError = yield* issueAssetUrl({ resource, workspaceRoot: root }).pipe(
          Effect.flip,
        );
        expect(previewError._tag).toBe("AssetPreviewTypeValidationError");
        const result = yield* issueAssetUrl({
          resource: { ...resource, download: true },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separatorIndex = suffix.indexOf("/");
        const token = suffix.slice(0, separatorIndex);
        const download = yield* resolveAsset(token, suffix.slice(separatorIndex + 1));
        expect(download).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(archivePath),
          downloadName: fileName,
        });
        expect(yield* resolveAsset(token, "sibling.txt")).toBeNull();
        expect(yield* resolveAsset(token, "../" + encodeURIComponent(fileName))).toBeNull();
        expect(yield* resolveAsset(`${token}tampered`, encodeURIComponent(fileName))).toBeNull();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects downloads outside the thread workspace and missing files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-download-root-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-download-outside-" });
      const file = path.join(outside, "archive.zip");
      yield* fileSystem.writeFileString(file, "outside");
      const resource = {
        _tag: "workspace-file" as const,
        threadId: ThreadId.make("thread-1"),
        path: file,
        download: true,
      };
      const outsideError = yield* issueAssetUrl({ resource, workspaceRoot: root }).pipe(
        Effect.flip,
      );
      expect(outsideError._tag).toBe("AssetWorkspacePathValidationError");
      const missingError = yield* issueAssetUrl({
        resource: { ...resource, path: path.join(root, "missing.zip") },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(missingError._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves non-missing canonical path failures when issuing asset URLs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-permission-root-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>report</p>");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: htmlPath,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: () => Effect.fail(cause),
      });

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

      expect(error.message).toBe("Failed to inspect the workspace asset.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetInspectionError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact workspace URLs for image previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      const imagePath = path.join(assetsDirectory, "icon.png");
      const siblingPath = path.join(assetsDirectory, "other.png");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([137, 80, 78, 71]));
      const canonicalImagePath = yield* fileSystem.realPath(imagePath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: imagePath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "icon.png")).toEqual({
        kind: "file",
        path: canonicalImagePath,
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../icon.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact attachment capabilities by attachment id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "ignored.png")).toEqual({
        kind: "file",
        path: attachmentPath,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      const initialFavicon = "<svg>a</svg>";
      const updatedFavicon = "<svg>b</svg>";
      expect(updatedFavicon).toHaveLength(initialFavicon.length);
      yield* fileSystem.writeFileString(faviconPath, initialFavicon);
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(faviconResult.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
      expect(
        yield* issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
        }),
      ).toEqual(faviconResult);
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.writeFileString(faviconPath, updatedFavicon);
      const updatedFaviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(
        updatedFaviconResult.relativeUrl.slice(updatedFaviconResult.relativeUrl.lastIndexOf("/")),
      ).not.toBe(faviconResult.relativeUrl.slice(faviconResult.relativeUrl.lastIndexOf("/")));

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("buckets project favicon expiry after content hashing", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-expiry-",
      });
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg />");

      const bucketMs = 30 * 60 * 1000;
      yield* TestClock.setTime(bucketMs - 1);
      const crossingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, data) =>
          TestClock.adjust("2 millis").pipe(Effect.andThen(crypto.digest(algorithm, data))),
      });
      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(Effect.provideService(Crypto.Crypto, crossingCrypto));

      expect(result.expiresAt).toBe(3 * bucketMs);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves structured project favicon resolution causes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-error-",
      });
      const platformCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
      });
      const resolutionCause = new ProjectFaviconResolver.ProjectFaviconResolutionError({
        operation: "stat-candidate",
        workspaceRoot: root,
        relativePath: "favicon.svg",
        cause: platformCause,
      });
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => Effect.fail(resolutionCause),
      });

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.flip,
      );

      expect(error.message).toBe("Failed to resolve project favicon.");
      expect(error._tag).toBe("AssetProjectFaviconResolutionError");
      expect(error.cause).toBe(resolutionCause);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns fallback favicon URL when project workspace directory no longer exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-missing-",
      });
      const missingRoot = path.join(parent, "deleted-project-dir");

      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: missingRoot },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      const suffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const sep = suffix.indexOf("/");
      expect(yield* resolveAsset(suffix.slice(0, sep), suffix.slice(sep + 1))).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("signs bounded text preview and original download capabilities separately", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const id = "thread-1-12345678-1234-1234-1234-123456789abc";
      yield* fileSystem.writeFileString(
        path.join(config.attachmentsDir, id + ".bin"),
        "한글 결과\r\n",
      );
      const preview = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId: id, preview: true },
      });
      const download = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId: id, downloadName: "한글 자료.txt" },
      });
      const resolve = (relative: string) => {
        const suffix = relative.slice((ASSET_ROUTE_PREFIX + "/").length);
        const separator = suffix.indexOf("/");
        return resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      };
      expect(yield* resolve(preview.relativeUrl)).toMatchObject({ kind: "file", preview: true });
      expect(yield* resolve(download.relativeUrl)).toMatchObject({
        kind: "file",
        downloadName: "한글 자료.txt",
      });
      expect(preview.relativeUrl).not.toBe(download.relativeUrl);
    }).pipe(Effect.provide(testLayer)),
  );

  it("resolves cross-project absolute asset paths to the longest matching registered workspace root while keeping relative and arbitrary OS paths scoped", () => {
    const roots = ["D:\\__job", "D:\\__NewAutoUsage", "D:\\__NewAutoUsage\\__XPeed"];
    // Cross-project HTML gallery clicked from D:\__job thread matches D:\__NewAutoUsage
    expect(
      resolveRegisteredWorkspaceRootForAssetPath({
        primaryWorkspaceRoot: "D:\\__job",
        requestedPath: "D:/__NewAutoUsage/.t3/t3-ppt-screenshots-2026-11-21/index.html",
        registeredWorkspaceRoots: roots,
      }),
    ).toBe("D:\\__NewAutoUsage");

    // Longest matching registered root wins for nested projects
    expect(
      resolveRegisteredWorkspaceRootForAssetPath({
        primaryWorkspaceRoot: "D:\\__job",
        requestedPath: "D:\\__NewAutoUsage\\__XPeed\\report.html",
        registeredWorkspaceRoots: roots,
      }),
    ).toBe("D:\\__NewAutoUsage\\__XPeed");

    // Arbitrary OS paths outside all registered projects fall back to primary root (and are rejected downstream)
    expect(
      resolveRegisteredWorkspaceRootForAssetPath({
        primaryWorkspaceRoot: "D:\\__job",
        requestedPath: "C:\\Windows\\System32\\drivers\\etc\\hosts",
        registeredWorkspaceRoots: roots,
      }),
    ).toBe("D:\\__job");

    // Relative paths never escape the thread's own primary workspace root
    expect(
      resolveRegisteredWorkspaceRootForAssetPath({
        primaryWorkspaceRoot: "D:\\__job",
        requestedPath: "..\\__NewAutoUsage\\.t3\\index.html",
        registeredWorkspaceRoots: roots,
      }),
    ).toBe("D:\\__job");
  });
});
