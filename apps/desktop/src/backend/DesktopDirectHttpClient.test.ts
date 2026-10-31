// @effect-diagnostics preferSchemaOverJson:off -- The fixture exchanges RPC JSON frames.
import type { DesktopDirectRpcOutput } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { directHttpRequest, selectDirectHttpBearerToken } from "./DesktopDirectHttpClient.ts";
import type { DesktopDirectRpcHub } from "./DesktopDirectRpcHub.ts";

it("keeps Google reauthentication reachable when the selected token has expired", () => {
  expect(
    selectDirectHttpBearerToken(
      new Request("t3code://app/api/auth/google/challenge"),
      "primary",
      "expired",
    ),
  ).toBeUndefined();
  expect(
    selectDirectHttpBearerToken(
      new Request("t3code://app/api/auth/google/token"),
      "primary",
      "expired",
    ),
  ).toBeUndefined();
  expect(
    selectDirectHttpBearerToken(
      new Request("t3code://app/api/auth/session"),
      "primary",
      "selected",
    ),
  ).toBe("selected");
  expect(
    selectDirectHttpBearerToken(
      new Request("t3code://app/api/auth/session"),
      "wsl:Ubuntu",
      "selected",
    ),
  ).toBeUndefined();
});

it("streams local HTTP responses over the direct RPC hub", async () => {
  let deliver: (frame: DesktopDirectRpcOutput) => void = () => {};
  let acknowledgements = 0;
  let closed = false;
  let payload: unknown;
  let openedToken: string | undefined;
  const emit = (message: object) =>
    deliver({ type: "data", clientId: 4, data: JSON.stringify(message) });
  const hub: DesktopDirectRpcHub["Service"] = {
    attach: Effect.die("unused"),
    attachBackend: () => Effect.die("unused"),
    open: (_owner, callback, _backendId, bearerToken) =>
      Effect.sync(() => {
        openedToken = bearerToken;
        deliver = callback;
        deliver({ type: "opened", clientId: 4 });
        return 4;
      }),
    send: (_owner, _id, data) =>
      Effect.sync(() => {
        const message = JSON.parse(data);
        if (message._tag === "Request") {
          payload = message.payload;
          emit({
            _tag: "Chunk",
            requestId: "http",
            values: [
              {
                type: "headers",
                status: 200,
                statusText: "OK",
                headers: [{ name: "content-type", value: "text/plain" }],
              },
            ],
          });
        } else if (message._tag === "Ack") {
          acknowledgements++;
          if (acknowledgements === 1) {
            emit({
              _tag: "Chunk",
              requestId: "http",
              values: [
                {
                  type: "chunk",
                  data: Buffer.from("한글 image").toString("base64"),
                },
              ],
            });
          } else if (acknowledgements === 2) {
            emit({ _tag: "Exit", requestId: "http", exit: { _tag: "Success" } });
          }
        }
      }),
    close: () =>
      Effect.sync(() => {
        closed = true;
      }),
    closeOwner: () => Effect.void,
  };

  const response = await directHttpRequest(
    hub,
    new Request("t3code://app/api/assets/x?view=1"),
    "primary",
    "google-session",
  );
  expect(openedToken).toBe("google-session");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain");
  expect(await response.text()).toBe("한글 image");
  expect(payload).toMatchObject({ method: "GET", path: "/api/assets/x?view=1" });
  expect(acknowledgements).toBe(2);
  expect(closed).toBe(true);
});

it("closes a pending local request when it is cancelled", async () => {
  let closed = false;
  const hub: DesktopDirectRpcHub["Service"] = {
    attach: Effect.die("unused"),
    attachBackend: () => Effect.die("unused"),
    open: () => Effect.succeed(5),
    send: () => Effect.void,
    close: () =>
      Effect.sync(() => {
        closed = true;
      }),
    closeOwner: () => Effect.void,
  };
  const abort = new AbortController();
  const pending = directHttpRequest(
    hub,
    new Request("t3code://app/api/test", { signal: abort.signal }),
  );
  await Promise.resolve();
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await Promise.resolve();
  expect(closed).toBe(true);
});
