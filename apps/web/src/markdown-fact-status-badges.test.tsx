import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { rehypeFactStatusBadges } from "./markdown-fact-status-badges";

const render = (text: string, badges = true) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize, ...(badges ? [rehypeFactStatusBadges] : [])]}
    >
      {text}
    </ReactMarkdown>,
  );

describe("rehypeFactStatusBadges", () => {
  it("renders recognised status tags as badges that copy as the original text", () => {
    const markup = render("매출 증가 [확인 완료], 원가는 **[검증 필요]** 입니다.");
    expect(markup).toContain('data-fact-status="success"');
    expect(markup).toContain('data-markdown-copy="[확인 완료]"');
    expect(markup).toContain(">확인 완료</span>");
    expect(markup).toContain('data-fact-status="warning"');
    expect(markup).toContain(">검증 필요</span></strong>");
    expect(markup).not.toContain("[확인 완료]<");
    expect(markup).toContain("매출 증가 <span");
  });

  it("maps every tone to an existing badge variant", () => {
    const markup = render("[확인 완료] [합리적 추정] [검증 필요] [미확인] [오류·반증]");
    expect(markup).toMatch(/class="[^"]*bg-success\/8[^"]*"[^>]*data-fact-status="success"/);
    expect(markup).toMatch(/class="[^"]*bg-info\/8[^"]*"[^>]*data-fact-status="info"/);
    expect(markup).toMatch(/class="[^"]*bg-warning\/8[^"]*"[^>]*data-fact-status="warning"/);
    expect(markup).toMatch(/class="[^"]*border-input[^"]*"[^>]*data-fact-status="muted"/);
    expect(markup).toMatch(/class="[^"]*bg-destructive\/8[^"]*"[^>]*data-fact-status="danger"/);
  });

  it("leaves inline code, fenced code and unknown tags alone", () => {
    const text = [
      "표기는 `[확인 완료]` 형식이고 [임의 태그]는 그대로 둡니다.",
      "",
      "```text",
      "[검증 필요] 코드 안",
      "```",
      "",
      "<pre>[미확인] 원문</pre>",
    ].join("\n");
    const markup = render(text);
    expect(markup).not.toContain("data-fact-status");
    expect(markup).toBe(render(text, false));
  });

  it("changes nothing for text without status tags", () => {
    const text = "# 제목\n\n- [ ] 할 일\n- [x] 끝난 일\n\n[링크](https://example.com) 와 본문";
    expect(render(text)).toBe(render(text, false));
  });

  it("handles a tag that is still arriving", () => {
    expect(render("진행 중 [확인 완")).toBe(render("진행 중 [확인 완", false));
    expect(render("진행 중 [확인 완료]")).toContain('data-fact-status="success"');
  });
});
