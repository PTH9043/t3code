/** Resolve the gateway's API root for both console URLs and documented /v1 URLs. */
export function antseedApiBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Antseed API URL must be HTTP(S) without credentials, query, or fragment.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString().replace(/\/+$/, "");
}
