import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { NonNegativeInt } from "./baseSchemas.ts";

/** Existing queue capacity used by both ends of the private direct channel. */
export const DESKTOP_DIRECT_RPC_QUEUE_CAPACITY = 64;

/** Frames carried by the private desktop-to-backend pipe, not by a network socket. */
export const DesktopDirectRpcInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("open"),
    clientId: NonNegativeInt,
    bearerToken: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("data"),
    clientId: NonNegativeInt,
    data: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("close"), clientId: NonNegativeInt }),
]);
export type DesktopDirectRpcInput = typeof DesktopDirectRpcInput.Type;

export const DesktopDirectRpcOutput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("opened"), clientId: NonNegativeInt }),
  Schema.Struct({
    type: Schema.Literal("data"),
    clientId: NonNegativeInt,
    data: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("closed"), clientId: NonNegativeInt }),
]);
export type DesktopDirectRpcOutput = typeof DesktopDirectRpcOutput.Type;

const Header = Schema.Struct({ name: Schema.String, value: Schema.String });

/** Internal-only HTTP routing over the private desktop process pipe. */
export const DesktopDirectHttpRpc = Rpc.make("desktop.directHttp", {
  payload: Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    headers: Schema.Array(Header),
    body: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("headers"),
      status: Schema.Number,
      statusText: Schema.String,
      headers: Schema.Array(Header),
    }),
    Schema.Struct({ type: Schema.Literal("chunk"), data: Schema.String }),
  ]),
  error: Schema.String,
  stream: true,
});
