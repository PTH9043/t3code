import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import { AI_HELP_CHANNEL, AI_HELP_HTML, parseAiHelpMessage } from "./aiHelp.ts";

function mountGuide(native = false) {
  const controls = new Map(
    ["guide-search", "search-status", "feedback", "empty", "reset", "print", "main"].map((id) => [
      id,
      {
        value: "",
        textContent: "",
        hidden: false,
        addEventListener: vi.fn<(name: string, listener: () => void) => void>(),
        focus: vi.fn(),
      },
    ]),
  );
  const sections = [
    ...AI_HELP_HTML.matchAll(/<section id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g),
  ].map(([, id, content]) => {
    const heading = { textContent: id };
    const item = {
      hidden: false,
      textContent: content,
      getAttribute: () => "",
      closest: () => ({ querySelector: () => heading }),
    };
    return {
      id,
      hidden: false,
      item,
      querySelectorAll: () => [item],
      setAttribute: vi.fn(),
      focus: vi.fn(),
      scrollIntoView: vi.fn(),
    };
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const postMessage = vi.fn();
  const document = {
    getElementById: (id: string) =>
      sections.find((section) => section.id === id) ?? controls.get(id),
    querySelectorAll: (selector: string) =>
      selector === "[data-search]" ? sections.map((section) => section.item) : sections,
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
  };
  const script = AI_HELP_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("The guide script is missing");
  NodeVM.runInNewContext(script, {
    document,
    window: {
      parent: { postMessage },
      ReactNativeWebView: native ? { postMessage } : undefined,
      addEventListener: vi.fn(),
    },
  });
  return {
    sections,
    search: controls.get("guide-search")!,
    postMessage,
    click(href: string) {
      const link = { getAttribute: () => href, href };
      const event = {
        // Also covers a click on text/icons nested inside an anchor.
        target: { closest: (selector: string) => (selector === "a" ? link : null) },
        preventDefault: vi.fn(),
      };
      listeners.get("click")!(event);
      return event;
    },
    filter() {
      const handler = controls.get("guide-search")!.addEventListener.mock.calls[0]?.[1];
      if (!handler) throw new Error("The search listener is missing");
      handler();
    },
  };
}

describe("AI help message boundary", () => {
  it("accepts bounded copy requests from web objects and native JSON", () => {
    const request = {
      channel: AI_HELP_CHANNEL,
      action: "copy",
      requestId: 2,
      text: "검증 후 적용해줘",
    };
    const expected = { action: "copy", requestId: 2, text: request.text };
    expect(parseAiHelpMessage(request)).toEqual(expected);
    expect(parseAiHelpMessage(JSON.stringify(request))).toEqual(expected);
  });

  it("rejects malformed, unrelated, oversized and invalid copy requests", () => {
    const base = { channel: AI_HELP_CHANNEL, action: "copy", requestId: 1, text: "명령" };
    for (const value of [
      null,
      "{",
      [],
      { ...base, channel: "other" },
      { ...base, text: "" },
      { ...base, text: "x".repeat(20_001) },
      { ...base, requestId: -1 },
      { ...base, requestId: 1.5 },
      { ...base, requestId: 1_000_001 },
      { ...base, requestId: "1" },
      "x".repeat(30_001),
    ]) {
      expect(parseAiHelpMessage(value)).toBeNull();
    }
  });

  it("accepts source links and refuses non-web or credential-bearing links", () => {
    const request = { channel: AI_HELP_CHANNEL, action: "open-link" };
    expect(
      parseAiHelpMessage({ ...request, url: "https://code.claude.com/docs/en/commands" }),
    ).toEqual({ action: "open-link", url: "https://code.claude.com/docs/en/commands" });
    for (const url of [
      "javascript:alert(1)",
      "file:///private",
      "http://example.com",
      "https://user:secret@example.com",
      "invalid",
    ]) {
      expect(parseAiHelpMessage({ ...request, url })).toBeNull();
    }
  });

  it("handles closing separately from clipboard or navigation requests", () => {
    expect(parseAiHelpMessage({ channel: AI_HELP_CHANNEL, action: "close" })).toEqual({
      action: "close",
    });
    expect(
      parseAiHelpMessage({ channel: AI_HELP_CHANNEL, action: "execute", command: "node" }),
    ).toBeNull();
  });
});

describe("offline HTML guide", () => {
  it("keeps every table-of-contents target reachable and IDs unique", () => {
    const ids = [...AI_HELP_HTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of AI_HELP_HTML.matchAll(/href="#([^"]+)"/g)) expect(ids).toContain(match[1]);
  });

  it("loads no external assets or network requests when opened", () => {
    expect(AI_HELP_HTML).not.toMatch(/<(script|link|iframe|img)[^>]+\b(src|href)=["']https?:/i);
    expect(AI_HELP_HTML).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/);
    expect(AI_HELP_HTML).toContain("connect-src 'none'");
    expect(Buffer.byteLength(AI_HELP_HTML)).toBeLessThan(100_000);
  });

  it("retains literal Windows paths and encodes command quotes in attributes", () => {
    expect(AI_HELP_HTML).toContain("D:\\__NewAutoUsage");
    expect(AI_HELP_HTML).toContain(
      'data-copy-command="codex exec &quot;이 프로젝트의 구조를 설명해줘&quot;"',
    );
    expect(AI_HELP_HTML).toContain("&lt;이름&gt;/SKILL.md");
  });
});

describe("embedded guide navigation", () => {
  it.each(
    [...AI_HELP_HTML.match(/<nav[\s\S]*?<\/nav>/)![0].matchAll(/href="(#[^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  )("scrolls to %s without navigating the embedded document", (href) => {
    const guide = mountGuide();
    const event = guide.click(href);
    const section = guide.sections.find((entry) => entry.id === href.slice(1))!;
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(section.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(section.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(guide.postMessage).not.toHaveBeenCalled();
  });

  it("reveals a filtered section before moving to it", () => {
    const guide = mountGuide();
    guide.search.value = "no-matching-help-item-12345";
    guide.filter();
    expect(guide.sections.every((section) => section.hidden)).toBe(true);

    guide.click("#automatic-work");

    expect(guide.search.value).toBe("");
    expect(guide.sections.every((section) => !section.hidden && !section.item.hidden)).toBe(true);
    expect(
      guide.sections.find((section) => section.id === "automatic-work")!.scrollIntoView,
    ).toHaveBeenCalledOnce();
  });

  it("does not navigate to a missing fragment", () => {
    const guide = mountGuide();
    expect(guide.click("#missing-section").preventDefault).toHaveBeenCalledOnce();
    expect(guide.sections.every((section) => section.scrollIntoView.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it("preserves external links in web and sends them to the native host on mobile", () => {
    const href = "https://github.com/openai/codex";
    const web = mountGuide();
    expect(web.click(href).preventDefault).not.toHaveBeenCalled();
    expect(web.postMessage).not.toHaveBeenCalled();

    const mobile = mountGuide(true);
    expect(mobile.click(href).preventDefault).toHaveBeenCalledOnce();
    expect(JSON.parse(mobile.postMessage.mock.calls[0]![0])).toEqual({
      action: "open-link",
      url: href,
      channel: AI_HELP_CHANNEL,
    });
  });
});
