import type { AssetResource } from "@t3tools/contracts";
import {
  AssetAttachmentNotFoundError,
  AssetPreviewTypeValidationError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetSigningKeyLoadError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspacePathValidationError,
  AssetWorkspaceResolutionError,
  AssetWorkspaceRootNormalizationError,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";

const SIGNING_SECRET_NAME = "asset-access-signing-key";
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
const PROJECT_FAVICON_TOKEN_BUCKET_MS = 30 * 60 * 1000;
const PROJECT_FAVICON_VERSION_PREFIX = "v";
const ISSUED_ASSET_URL_CACHE_MAX = 1_024;
const ISSUED_ASSET_URL_MIN_REMAINING_MS = 15 * 60 * 1000;

interface CachedIssuedAssetUrl {
  readonly relativeUrl: string;
  readonly expiresAt: number;
  readonly secretFingerprint: string;
}

const issuedAssetUrlCache = new Map<string, CachedIssuedAssetUrl>();

function secretFingerprint(secret: Uint8Array): string {
  // Fast non-reversible prefix+length tag to invalidate cached URLs if the signing secret rotates.
  return `${secret.length}:${secret[0] ?? 0}:${secret[1] ?? 0}:${secret[secret.length - 1] ?? 0}`;
}

function readIssuedAssetUrlCache(
  key: string,
  nowMs: number,
  fingerprint: string,
): { readonly relativeUrl: string; readonly expiresAt: number } | null {
  const entry = issuedAssetUrlCache.get(key);
  if (!entry) return null;
  if (
    entry.secretFingerprint !== fingerprint ||
    entry.expiresAt - nowMs < ISSUED_ASSET_URL_MIN_REMAINING_MS
  ) {
    issuedAssetUrlCache.delete(key);
    return null;
  }
  // Refresh LRU recency
  issuedAssetUrlCache.delete(key);
  issuedAssetUrlCache.set(key, entry);
  return { relativeUrl: entry.relativeUrl, expiresAt: entry.expiresAt };
}

function writeIssuedAssetUrlCache(key: string, entry: CachedIssuedAssetUrl): void {
  if (issuedAssetUrlCache.has(key)) {
    issuedAssetUrlCache.delete(key);
  } else if (issuedAssetUrlCache.size >= ISSUED_ASSET_URL_CACHE_MAX) {
    const oldestKey = issuedAssetUrlCache.keys().next().value;
    if (oldestKey !== undefined) {
      issuedAssetUrlCache.delete(oldestKey);
    }
  }
  issuedAssetUrlCache.set(key, entry);
}

export function clearIssuedAssetUrlCacheForTest(): void {
  issuedAssetUrlCache.clear();
}
const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

const AssetClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file"),
    workspaceRoot: Schema.String,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file-exact"),
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    download: Schema.optional(Schema.Boolean),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    preview: Schema.optional(Schema.Boolean),
    downloadName: Schema.optional(Schema.String),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
  }),
]);
type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset = {
  readonly kind: "file";
  readonly path: string;
  readonly downloadName?: string;
  readonly preview?: boolean;
};

function decodeClaims(encodedPayload: string): AssetClaims | null {
  try {
    return Option.getOrNull(decodeAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeed(Option.none()),
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value));
    return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
  },
);

const resolveCanonicalWorkspaceFileForRequest = (input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}) =>
  resolveCanonicalWorkspaceFile(input).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to resolve canonical asset path.", {
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

function normalizePathForRootComparison(value: string): string {
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  const isWindowsUnc = value.startsWith("\\\\");
  const normalized = value.replaceAll("\\", "/");
  const stripped =
    normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)
      ? normalized.replace(/\/+$/, "")
      : normalized;
  return isWindowsDrive || isWindowsUnc ? stripped.toLowerCase() : stripped;
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizePathForRootComparison(candidatePath);
  const normalizedRoot = normalizePathForRootComparison(rootPath);
  if (!normalizedRoot) return false;
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCandidate.startsWith(prefix);
}

/**
 * Resolves which registered T3 workspace root should authorize an asset request.
 * Relative paths are strictly scoped to the thread's primary workspace root.
 * Absolute paths outside the current thread's root may match another active
 * registered T3 project root (longest matching root wins) so cross-project
 * preview links (e.g., an HTML gallery inside another registered workspace) work
 * without opening access to arbitrary OS paths.
 */
export function resolveRegisteredWorkspaceRootForAssetPath(input: {
  readonly primaryWorkspaceRoot: string;
  readonly requestedPath: string;
  readonly registeredWorkspaceRoots: ReadonlyArray<string>;
}): string {
  const raw = input.requestedPath.trim();
  const isAbsolute = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
  if (!isAbsolute) {
    return input.primaryWorkspaceRoot;
  }
  if (isPathInsideRoot(raw, input.primaryWorkspaceRoot)) {
    return input.primaryWorkspaceRoot;
  }
  let bestRoot: string | null = null;
  let bestLen = -1;
  for (const root of input.registeredWorkspaceRoots) {
    if (!root || !isPathInsideRoot(raw, root)) continue;
    const compareLen = normalizePathForRootComparison(root).length;
    if (compareLen > bestLen) {
      bestLen = compareLen;
      bestRoot = root;
    }
  }
  return bestRoot ?? input.primaryWorkspaceRoot;
}

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  let expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
  let claims: AssetClaims;
  let fileName: string;

  switch (input.resource._tag) {
    case "workspace-file": {
      if (!input.workspaceRoot) {
        return yield* new AssetWorkspaceContextNotFoundError({
          resource: input.resource,
        });
      }
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = path.isAbsolute(input.resource.path)
        ? path.relative(workspaceRoot, input.resource.path)
        : input.resource.path;
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspacePathValidationError({
                resource: input.resource,
                cause,
              }),
          ),
        );
      if (!input.resource.download && !isWorkspacePreviewEntryPath(resolved.relativePath)) {
        return yield* new AssetPreviewTypeValidationError({
          resource: input.resource,
        });
      }
      const canonicalFile = yield* resolveCanonicalWorkspaceFile({
        workspaceRoot,
        relativePath: resolved.relativePath,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceAssetInspectionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (!canonicalFile) {
        return yield* new AssetWorkspaceAssetNotFoundError({
          resource: input.resource,
        });
      }
      const canonicalWorkspaceRoot = yield* fileSystem.realPath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      claims =
        input.resource.download || isWorkspaceImagePreviewPath(resolved.relativePath)
          ? {
              version: 1,
              kind: "workspace-file-exact",
              workspaceRoot: canonicalWorkspaceRoot,
              relativePath: resolved.relativePath,
              ...(input.resource.download ? { download: true } : {}),
              expiresAt,
            }
          : {
              version: 1,
              kind: "workspace-file",
              workspaceRoot: canonicalWorkspaceRoot,
              baseRelativePath: path.dirname(resolved.relativePath),
              expiresAt,
            };
      fileName = path.basename(resolved.relativePath);
      break;
    }
    case "attachment": {
      const config = yield* ServerConfig.ServerConfig;
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.resource.attachmentId,
      });
      if (!attachmentPath) {
        return yield* new AssetAttachmentNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        ...(input.resource.preview ? { preview: true } : {}),
        ...(input.resource.downloadName ? { downloadName: input.resource.downloadName } : {}),
        expiresAt,
      };
      fileName = path.basename(attachmentPath);
      break;
    }
    case "project-favicon": {
      const normalizedWorkspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(input.resource.cwd)
        .pipe(
          Effect.map(Option.some),
          Effect.catchTag("WorkspaceRootNotExistsError", () => Effect.succeed(Option.none())),
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceRootNormalizationError({
                resource: input.resource,
                cause,
              }),
          ),
        );
      if (Option.isNone(normalizedWorkspaceRoot)) {
        claims = {
          version: 1,
          kind: "project-favicon",
          workspaceRoot: input.resource.cwd,
          relativePath: null,
          expiresAt,
        };
        fileName = PROJECT_FAVICON_FALLBACK_MARKER;
        break;
      }
      const workspaceRoot = normalizedWorkspaceRoot.value;
      const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
      const faviconPath = yield* faviconResolver.resolvePath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetProjectFaviconResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = faviconPath ? path.relative(workspaceRoot, faviconPath) : null;
      const canonicalFaviconPath = relativePath
        ? yield* resolveCanonicalWorkspaceFile({ workspaceRoot, relativePath }).pipe(
            Effect.mapError(
              (cause) =>
                new AssetProjectFaviconInspectionError({
                  resource: input.resource,
                  cause,
                }),
            ),
          )
        : null;
      if (relativePath && !canonicalFaviconPath) {
        return yield* new AssetProjectFaviconNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "project-favicon",
        workspaceRoot: yield* fileSystem.realPath(workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceResolutionError({
                resource: input.resource,
                cause,
              }),
          ),
        ),
        relativePath,
        expiresAt,
      };
      if (relativePath && canonicalFaviconPath) {
        const crypto = yield* Crypto.Crypto;
        const faviconBytes = yield* fileSystem.readFile(canonicalFaviconPath).pipe(
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        const revision = yield* crypto.digest("SHA-256", faviconBytes).pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        fileName = `${PROJECT_FAVICON_VERSION_PREFIX}${revision}-${path.basename(relativePath)}`;
      } else {
        fileName = PROJECT_FAVICON_FALLBACK_MARKER;
      }
      break;
    }
  }

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.mapError(
      (cause) =>
        new AssetSigningKeyLoadError({
          resource: input.resource,
          cause,
        }),
    ),
  );
  const issuedAt = yield* Clock.currentTimeMillis;
  if (claims.kind === "project-favicon") {
    expiresAt =
      (Math.floor(issuedAt / PROJECT_FAVICON_TOKEN_BUCKET_MS) + 2) *
      PROJECT_FAVICON_TOKEN_BUCKET_MS;
    claims = { ...claims, expiresAt };
  }
  const cacheKey = `${claims.kind}:${fileName}:${
    claims.kind === "attachment"
      ? `${claims.attachmentId}:${claims.preview ? "1" : "0"}:${claims.downloadName ?? ""}`
      : claims.kind === "project-favicon"
        ? `${claims.workspaceRoot}:${claims.relativePath ?? ""}`
        : claims.kind === "workspace-file-exact"
          ? `${claims.workspaceRoot}:${claims.relativePath}:${claims.download ? "1" : "0"}`
          : `${claims.workspaceRoot}:${claims.baseRelativePath}`
  }`;
  const fp = secretFingerprint(signingSecret);
  const cachedUrl = readIssuedAssetUrlCache(cacheKey, issuedAt, fp);
  if (cachedUrl) {
    return cachedUrl;
  }
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  const issued = {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
  };
  writeIssuedAssetUrlCache(cacheKey, {
    ...issued,
    secretFingerprint: fp,
  });
  return issued;
});

export const resolveAsset = Effect.fn("AssetAccess.resolveAsset")(function* (
  token: string,
  relativePath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => null),
  );
  if (!signingSecret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) return null;

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

  if (claims.kind === "attachment") {
    const config = yield* ServerConfig.ServerConfig;
    const attachmentPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: claims.attachmentId,
    });
    if (!attachmentPath) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* optionOnNotFound(fileSystem.stat(attachmentPath)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to inspect attachment asset.", {
          attachmentId: claims.attachmentId,
          path: attachmentPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({
          kind: "file",
          path: attachmentPath,
          ...(claims.preview ? { preview: true } : {}),
          ...(claims.downloadName ? { downloadName: claims.downloadName } : {}),
        } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "project-favicon") {
    if (claims.relativePath === null) return null;
    const faviconPath = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return faviconPath ? ({ kind: "file", path: faviconPath } satisfies ResolvedAsset) : null;
  }

  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  const path = yield* Path.Path;
  if (claims.kind === "workspace-file-exact") {
    if (decodedPath !== path.basename(claims.relativePath)) return null;
    const exactWorkspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return exactWorkspaceFile
      ? ({
          kind: "file",
          path: exactWorkspaceFile,
          ...(claims.download ? { downloadName: path.basename(claims.relativePath) } : {}),
        } satisfies ResolvedAsset)
      : null;
  }
  const segments = decodedPath.split(/[\\/]/);
  if (
    decodedPath.length === 0 ||
    decodedPath.includes("\0") ||
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
    !PREVIEW_ASSET_EXTENSIONS.has(path.extname(decodedPath).toLowerCase())
  ) {
    return null;
  }
  const joinedRelativePath =
    claims.baseRelativePath === "." ? decodedPath : path.join(claims.baseRelativePath, decodedPath);
  const workspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
    workspaceRoot: claims.workspaceRoot,
    relativePath: joinedRelativePath,
  });
  return workspaceFile ? ({ kind: "file", path: workspaceFile } satisfies ResolvedAsset) : null;
});
