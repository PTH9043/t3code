import * as NodeAssert from "node:assert/strict";

const origin = `http://127.0.0.1:${process.env.T3CODE_PORT ?? "3773"}`;

try {
  const descriptorResponse = await fetch(`${origin}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(4_000),
  });
  NodeAssert.equal(descriptorResponse.status, 200, "Environment API is unavailable");
  const descriptor = await descriptorResponse.json();
  NodeAssert.equal(typeof descriptor.environmentId, "string", "Environment identity is missing");

  const webResponse = await fetch(origin, { signal: AbortSignal.timeout(4_000) });
  NodeAssert.equal(webResponse.status, 200, "Bundled web app is unavailable");
  NodeAssert.match(webResponse.headers.get("content-type") ?? "", /text\/html/i);
  NodeAssert.match(await webResponse.text(), /<html[\s>]/i);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
