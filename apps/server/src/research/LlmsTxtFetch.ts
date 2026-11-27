import { validatePreviewNavigationUrl } from "../mcp/HostSecurityGuard.ts";

export interface ProtocolFirstFetchResult {
  readonly ok: boolean;
  readonly source: "llms.txt" | "defuddle-local" | "firecrawl-local" | "blocked" | "unavailable";
  readonly url: string;
  readonly markdown: string;
  readonly message?: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

/**
 * Dependency-free local HTML content extractor (inspired by kepano/defuddle):
 * Strips scripts, styles, nav/header/footer/aside/cookie/ad chrome, focuses on
 * `<article>` or `<main>` when present, and emits clean Markdown to cut token waste.
 */
export function defuddleHtmlToMarkdown(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]!.replace(/\s+/g, " ").trim()) : "";

  // Prefer semantic main/article container when available
  const articleMatch =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ??
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let body = articleMatch ? articleMatch[1]! : html;

  // Strip non-content boilerplate tags and common cookie/banner/comment blocks
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|svg|canvas|iframe|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
      "\n",
    )
    .replace(
      /<(?:div|section)\b[^>]*(?:id|class)=["'][^"']*(?:cookie|consent|banner|sidebar|breadcrumb|comments?|advert|promo|newsletter|modal)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi,
      "\n",
    );

  // Convert structural tags to clean Markdown
  body = body
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n")
    .replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, label: string) => {
        const cleanLabel = label
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!cleanLabel) return "";
        return /^https?:\/\//i.test(href) ? `[${cleanLabel}](${href})` : cleanLabel;
      },
    )
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<(?:p|div|section|br|tr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const decoded = decodeHtmlEntities(body)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (title && !decoded.startsWith(`# ${title}`)) {
    return `# ${title}\n\n${decoded}`.trim();
  }
  return decoded;
}

/**
 * 3-Stage Protocol-First Web Ingestion (llms.txt -> local defuddle -> optional firecrawl-local):
 * 1) Validates target URL against HostSecurityGuard SSRF rules.
 * 2) Probes `<origin>/llms.txt` first for clean, deterministic agent docs.
 * 3) Fetches target URL HTML and strips boilerplate locally via `defuddleHtmlToMarkdown`.
 * 4) Optionally falls back to local `firecrawl-local` (localhost:3002/v2/scrape) for CSR pages.
 */
export async function fetchProtocolFirstMarkdown(
  targetUrl: string,
  options?: {
    readonly fetchImpl?: typeof fetch;
    readonly firecrawlLocalUrl?: string;
    readonly timeoutMs?: number;
    readonly enableLocalDefuddle?: boolean;
  },
): Promise<ProtocolFirstFetchResult> {
  const ssrf = validatePreviewNavigationUrl(targetUrl, { allowLocalhost: false });
  if (!ssrf.allowed) {
    return {
      ok: false,
      source: "blocked",
      url: targetUrl,
      markdown: "",
      message: `SSRF guard blocked URL: ${ssrf.reason ?? "disallowed"}`,
    };
  }

  const fetchFn = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const parsed = new URL(targetUrl);
  const llmsUrl = `${parsed.origin}/llms.txt`;

  // Stage 1: /llms.txt
  try {
    const res = await fetchFn(llmsUrl, {
      method: "GET",
      headers: { Accept: "text/plain, text/markdown;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      if (!contentType.includes("text/html") && body.trim().length >= 30) {
        return {
          ok: true,
          source: "llms.txt",
          url: llmsUrl,
          markdown: body.trim(),
        };
      }
    }
  } catch {
    // Continue to Stage 2
  }

  // Stage 2: Dependency-free local defuddle HTML extraction
  if (options?.enableLocalDefuddle !== false) {
    try {
      const res = await fetchFn(targetUrl, {
        method: "GET",
        headers: { Accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const extracted = contentType.includes("text/html")
          ? defuddleHtmlToMarkdown(body)
          : body.trim();
        if (extracted.length >= 40) {
          return {
            ok: true,
            source: "defuddle-local",
            url: targetUrl,
            markdown: extracted,
          };
        }
      }
    } catch {
      // Continue to Stage 3
    }
  }

  // Stage 3: Optional local Firecrawl adapter for JS-heavy CSR pages
  if (options?.firecrawlLocalUrl) {
    try {
      const endpoint = `${options.firecrawlLocalUrl.replace(/\/$/, "")}/v2/scrape`;
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl, formats: ["markdown"] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { markdown?: string }; markdown?: string };
        const md = json.data?.markdown ?? json.markdown ?? "";
        if (md.trim().length > 0) {
          return {
            ok: true,
            source: "firecrawl-local",
            url: targetUrl,
            markdown: md.trim(),
          };
        }
      }
    } catch {
      // Unavailable
    }
  }

  return {
    ok: false,
    source: "unavailable",
    url: targetUrl,
    markdown: "",
    message: "llms.txt, 로컬 defuddle 정제, 로컬 Firecrawl 모두 본문을 추출하지 못했습니다.",
  };
}
