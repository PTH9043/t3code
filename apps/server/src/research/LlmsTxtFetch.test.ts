import { describe, expect, it } from "vite-plus/test";
import { defuddleHtmlToMarkdown, fetchProtocolFirstMarkdown } from "./LlmsTxtFetch.ts";

describe("LlmsTxtFetch & local defuddle extractor", () => {
  it("blocks SSRF private/metadata URLs before issuing any network request", async () => {
    let called = false;
    const res = await fetchProtocolFirstMarkdown("http://169.254.169.254/latest/meta-data/", {
      fetchImpl: (async () => {
        called = true;
        return new Response("nope");
      }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.source).toBe("blocked");
    expect(called).toBe(false);
  });

  it("strips scripts, nav, footer, and cookie banners via dependency-free defuddleHtmlToMarkdown", () => {
    const html = `
      <html>
        <head><title>Release Notes</title><style>body{color:red}</style></head>
        <body>
          <nav><a href="/home">Home</a><a href="/login">Login</a></nav>
          <div class="cookie-banner">Accept all cookies now</div>
          <main>
            <article>
              <h1>Release Notes</h1>
              <p>Fixed latency regression by 42% in <a href="https://example.com/pr/12">PR #12</a>.</p>
              <ul><li>Added ScopeGuard</li><li>Reduced tokens</li></ul>
            </article>
          </main>
          <footer>Copyright 2026</footer>
          <script>alert('noise')</script>
        </body>
      </html>
    `;
    const md = defuddleHtmlToMarkdown(html);
    expect(md).toContain("# Release Notes");
    expect(md).toContain("[PR #12](https://example.com/pr/12)");
    expect(md).toContain("- Added ScopeGuard");
    expect(md).not.toContain("Accept all cookies");
    expect(md).not.toContain("Copyright 2026");
    expect(md).not.toContain("alert('noise')");
  });

  it("prefers /llms.txt, falls back to local defuddle, then optional firecrawl-local", async () => {
    const llmsRes = await fetchProtocolFirstMarkdown("https://docs.example.com/api/v2", {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url) === "https://docs.example.com/llms.txt") {
          return new Response("# Example Docs\nClean protocol-first llms.txt index for agents.", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch,
    });
    expect(llmsRes.ok).toBe(true);
    expect(llmsRes.source).toBe("llms.txt");

    const defuddleRes = await fetchProtocolFirstMarkdown("https://blog.example.com/post", {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/llms.txt")) return new Response("404", { status: 404 });
        return new Response(
          "<html><head><title>Clean Post</title></head><body><nav>Menu</nav><article><p>Meaningful technical article content preserved cleanly without boilerplate.</p></article></body></html>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }) as unknown as typeof fetch,
    });
    expect(defuddleRes.ok).toBe(true);
    expect(defuddleRes.source).toBe("defuddle-local");
    expect(defuddleRes.markdown).toContain("Meaningful technical article content");
    expect(defuddleRes.markdown).not.toContain("Menu");

    const fcRes = await fetchProtocolFirstMarkdown("https://spa.example.org/pricing", {
      firecrawlLocalUrl: "http://localhost:3002",
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/llms.txt")) return new Response("404", { status: 404 });
        if (String(url) === "https://spa.example.org/pricing") {
          return new Response("<html><body><div id='root'></div></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (String(url) === "http://localhost:3002/v2/scrape") {
          return new Response(JSON.stringify({ data: { markdown: "# Pricing\n$20/mo" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("error", { status: 500 });
      }) as unknown as typeof fetch,
    });
    expect(fcRes.ok).toBe(true);
    expect(fcRes.source).toBe("firecrawl-local");
    expect(fcRes.markdown).toContain("$20/mo");
  });
});
