interface LockedDependency {
  specifier: string;
  version: string;
}

interface WorkspaceLock {
  lockfileVersion: string;
  settings: Record<string, unknown>;
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
  importers: Record<string, { dependencies: Record<string, LockedDependency> }>;
  packages: Record<string, unknown>;
  snapshots: Record<string, { optionalDependencies?: Record<string, string> }>;
  catalogs?: { default?: Record<string, LockedDependency> };
}

export function createWindowsStageLock(
  lock: WorkspaceLock,
  stage: { dependencies: Record<string, string>; devDependencies: Record<string, string> },
  patches: Record<string, string>,
) {
  if (lock.lockfileVersion !== "9.0")
    throw new Error(`Unsupported pnpm lockfile version ${lock.lockfileVersion}`);
  const direct = {
    ...lock.importers["apps/server"]!.dependencies,
    ...lock.importers["apps/desktop"]!.dependencies,
  };
  const fffBinaries =
    lock.snapshots[`@ff-labs/fff-node@${direct["@ff-labs/fff-node"]?.version}`]
      ?.optionalDependencies;
  function lockedEntries(specs: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(specs).map(([name, specifier]) => {
        const entry = direct[name];
        const version = entry?.version ?? fffBinaries?.[name];
        const lockedSpec =
          entry?.specifier === "catalog:"
            ? lock.catalogs?.default?.[name]?.specifier
            : (entry?.specifier ?? version);
        if (
          !version ||
          lockedSpec !== specifier ||
          !Object.hasOwn(lock.snapshots, `${name}@${version}`)
        ) {
          throw new Error(`No matching locked snapshot for staged dependency ${name}@${specifier}`);
        }
        return [name, { specifier, version }];
      }),
    );
  }
  // The standalone stage has resolved catalog specs, no packageExtensions and
  // only its selected patches. Keep peer and patch suffixes in snapshot IDs.
  return {
    lockfileVersion: lock.lockfileVersion,
    settings: lock.settings,
    overrides: lock.overrides,
    patchedDependencies: Object.fromEntries(
      Object.keys(patches).map((key) => {
        const hash = lock.patchedDependencies?.[key];
        if (!hash) throw new Error(`Missing lockfile hash for stage patch ${key}`);
        return [key, hash];
      }),
    ),
    importers: {
      ".": {
        dependencies: lockedEntries(stage.dependencies),
        devDependencies: lockedEntries(stage.devDependencies),
      },
    },
    packages: lock.packages,
    snapshots: lock.snapshots,
  };
}
