import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";

// Windows refuses to rename over a file that another handle currently has
// open without FILE_SHARE_DELETE — a concurrent reader of the same settings
// or cache file is enough — and reports it as EPERM (EBUSY/EACCES in some
// configurations). The reader's window is microseconds, so retry the rename
// briefly instead of failing the write and silently leaving the previous
// contents in place.
const TRANSIENT_RENAME_ERROR_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_TIMES = 10;
const RENAME_RETRY_DELAY = "20 millis";

const isTransientRenameError = (error: PlatformError.PlatformError): boolean => {
  const reason = error.reason;
  if (reason._tag === "BadArgument") return false;
  const cause: unknown = reason.cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { readonly code?: unknown }).code
      : undefined;
  return typeof code === "string" && TRANSIENT_RENAME_ERROR_CODES.has(code);
};

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        // Hash-named artifacts already consume most of the Windows path budget.
        prefix: ".t3-write-",
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* input.mode === undefined
        ? fs.writeFileString(tempPath, input.contents)
        : fs.writeFileString(tempPath, input.contents, { mode: input.mode });
      yield* fs.rename(tempPath, input.filePath).pipe(
        Effect.retry({
          while: isTransientRenameError,
          schedule: Schedule.spaced(RENAME_RETRY_DELAY).pipe(
            Schedule.upTo({ times: RENAME_RETRY_TIMES }),
          ),
        }),
      );
    }),
  );
