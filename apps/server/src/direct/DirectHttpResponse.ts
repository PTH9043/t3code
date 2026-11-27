// @effect-diagnostics nodeBuiltinImport:off -- Node file responses must be adapted before Web conversion.
import * as NodeStream from "node:stream";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Avoid Node's iterable-to-Web Response adapter when a direct request is cancelled. */
export function prepareDirectHttpResponse(
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse {
  const body = response.body;
  if (body._tag !== "Raw" || !(body.body instanceof NodeStream.Readable)) return response;
  const readable = body.body;
  return HttpServerResponse.stream(EffectNodeStream.fromReadable({ evaluate: () => readable }), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    cookies: response.cookies,
  });
}
