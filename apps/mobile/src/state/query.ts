import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-environment-query:empty"),
);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

function formatError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatError(result.cause) : null,
    isPending: atom !== null && result.waiting,
    refresh,
  };
}

export function useEnvironmentQuerySelector<A, E, B>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  select: (data: A) => B,
): B | null {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const selector = useCallback(
    (result: AsyncResult.AsyncResult<A, E>): B | null =>
      Option.match(AsyncResult.value(result), { onNone: () => null, onSome: select }),
    [select],
  );
  return useAtomValue(selectedAtom, selector);
}
