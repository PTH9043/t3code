import type { SharedLibraryMatch } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface SharedLibraryItemInput {
  readonly libraryId: string;
  readonly itemId: string;
  readonly source: string;
  readonly sourceRef: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly content: string;
  /** Indexed for search alongside the content, never injected into prompts. */
  readonly searchExtra: string;
  readonly tags: ReadonlyArray<string>;
  readonly category: string | null;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly fetchedAt: string;
}

export interface SharedLibrarySyncState {
  readonly source: string;
  readonly libraryId: string;
  /** Highest source reference stored so far — where an incremental scan resumes. */
  readonly maxRef: number;
  /** Last reference the full scan has looked at, so a restart resumes rather than restarts. */
  readonly scanCursor: number;
  readonly fullScanCompletedAt: string | null;
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
}

export interface SharedLibrarySearchInput {
  readonly query: string;
  readonly limit?: number;
  /**
   * Keep only matches covering at least two query terms, or one term in the
   * title or tags. Prompt composition asks for this: a coding task must not
   * pull in a design reference because both mention "검증" once.
   */
  readonly requireStrongMatch?: boolean;
}

export interface SharedLibraryRepositoryShape {
  readonly upsertItem: (
    item: SharedLibraryItemInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly hasItem: (input: {
    readonly libraryId: string;
    readonly itemId: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly search: (
    input: SharedLibrarySearchInput,
  ) => Effect.Effect<ReadonlyArray<SharedLibraryMatch>, ProjectionRepositoryError>;
  readonly countItems: () => Effect.Effect<
    ReadonlyArray<{ readonly libraryId: string; readonly itemCount: number }>,
    ProjectionRepositoryError
  >;
  readonly getSyncState: (
    source: string,
  ) => Effect.Effect<Option.Option<SharedLibrarySyncState>, ProjectionRepositoryError>;
  readonly listSyncStates: () => Effect.Effect<
    ReadonlyArray<SharedLibrarySyncState>,
    ProjectionRepositoryError
  >;
  readonly saveSyncState: (
    state: SharedLibrarySyncState & { readonly updatedAt: string },
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class SharedLibraryRepository extends Context.Service<
  SharedLibraryRepository,
  SharedLibraryRepositoryShape
>()("t3/persistence/Services/SharedLibrary/SharedLibraryRepository") {}
