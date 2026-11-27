// Refuse unknown gateway layouts: never patch an unrecognized installation.
export function patchAntseedGateway(source) {
  const anchor = "import * as http from 'node:http';";
  const statement =
    "                    res.writeHead(status, responseHeaders);\n                    upstreamRes.pipe(res);";
  if (source.split(anchor).length !== 2 || source.split(statement).length !== 2)
    throw new Error("Unknown Antseed gateway layout; refusing to patch.");
  return source
    .replace(
      anchor,
      `${anchor}\nimport { Transform } from 'node:stream';\nimport { createAntseedKimiStreamNormalizer } from './antseed-kimi-stream.mjs';`,
    )
    .replace(
      statement,
      `                    const fixKimi = status === 200 && request.requestPath === '/v1/chat/completions'\n                        && /(?:^|\\/)kimi[-.]k3[.-]1[-.]pro$/i.test(request.model ?? '')\n                        && contentType.toLowerCase().startsWith('text/event-stream');\n                    if (fixKimi) {\n                        delete responseHeaders['content-length'];\n                        responseHeaders['x-t3-kimi-tool-stream'] = 'normalized';\n                    }\n                    res.writeHead(status, responseHeaders);\n                    if (fixKimi) {\n                        const normalizer = createAntseedKimiStreamNormalizer();\n                        const normalized = new Transform({\n                            transform(chunk, _encoding, callback) {\n                                try { callback(null, normalizer.write(chunk)); } catch (error) { callback(error); }\n                            },\n                            flush(callback) {\n                                try { callback(null, normalizer.end()); } catch (error) { callback(error); }\n                            },\n                        });\n                        normalized.once('error', () => res.destroy());\n                        upstreamRes.pipe(normalized).pipe(res);\n                    } else {\n                        upstreamRes.pipe(res);\n                    }`,
    );
}
