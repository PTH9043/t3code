import { EnvironmentId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: (_envId: unknown, resource: { attachmentId?: string; path?: string }) => ({
    _tag: "Success" as const,
    url: `https://asset.invalid/${resource.attachmentId ?? resource.path ?? "item"}`,
  }),
}));

import ChatMarkdown from "../ChatMarkdown";
import { ChatGeneratedResults } from "./ChatGeneratedResults";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-1"),
};

function makeImageAttachment(id: string, name: string): ChatAttachment {
  return {
    type: "image",
    id,
    name,
    mimeType: "image/png",
    sizeBytes: 4096,
    result: {
      kind: "image",
      sha256: `sha-${id}`,
      sourcePath: `D:/project/${name}`,
      width: 1024,
      height: 768,
    },
  };
}

function makeReportAttachment(id: string, name: string): ChatAttachment {
  return {
    type: "file",
    id,
    name,
    mimeType: "text/markdown",
    sizeBytes: 8192,
    result: {
      kind: "text",
      sha256: `sha-${id}`,
      sourcePath: `D:/project/${name}`,
      language: "md",
    },
  };
}

describe("ChatGeneratedResults", () => {
  it("renders generated text reports collapsed by default", () => {
    const markup = renderToStaticMarkup(
      <ChatGeneratedResults
        attachments={[makeReportAttachment("report-1", "분석보고서.md")]}
        threadRef={THREAD_REF}
      />,
    );

    expect(markup).toContain('data-result-report-collapsed="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("분석보고서.md");
    expect(markup).toContain("(8.0 KB)");
    expect(markup).not.toContain("내용을 불러오는 중…");
  });

  it("keeps a single generated image as a standalone card", () => {
    const markup = renderToStaticMarkup(
      <ChatGeneratedResults
        attachments={[makeImageAttachment("img-1", "shot1.png")]}
        threadRef={THREAD_REF}
      />,
    );

    expect(markup).not.toContain('data-result-image-gallery="true"');
    expect(markup).toContain('aria-label="생성 이미지 shot1.png"');
  });

  it("groups multiple generated images into one grid gallery by default", () => {
    const markup = renderToStaticMarkup(
      <ChatGeneratedResults
        attachments={[
          makeImageAttachment("img-1", "shot1.png"),
          makeReportAttachment("report-1", "요약보고서.md"),
          makeImageAttachment("img-2", "shot2.png"),
          makeImageAttachment("img-3", "shot3.png"),
        ]}
        threadRef={THREAD_REF}
      />,
    );

    expect(markup).toContain('data-result-image-gallery="true"');
    expect(markup).toContain('data-result-image-count="3"');
    expect(markup).toContain('data-result-image-layout="grid"');
    expect(markup).toContain("생성 이미지 3장");
    expect(markup).toContain("grid-cols-2 sm:grid-cols-3");
    expect(markup).toContain("shot1.png");
    expect(markup).toContain("shot2.png");
    expect(markup).toContain("shot3.png");
    expect(markup).toContain('data-result-report-collapsed="true"');
  });

  it("uses a 2-column grid for 2 or 4 generated images", () => {
    const markup = renderToStaticMarkup(
      <ChatGeneratedResults
        attachments={[
          makeImageAttachment("img-1", "a.png"),
          makeImageAttachment("img-2", "b.png"),
          makeImageAttachment("img-3", "c.png"),
          makeImageAttachment("img-4", "d.png"),
        ]}
        threadRef={THREAD_REF}
      />,
    );

    expect(markup).toContain('data-result-image-count="4"');
    expect(markup).toContain("grid-cols-2");
    expect(markup).not.toContain("sm:grid-cols-3");
  });
});

describe("ChatMarkdown inline image gallery grouping", () => {
  it("groups consecutive markdown images separated by blank lines into one grid", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={[
          "생성된 시안입니다.",
          "",
          "![시안 1](https://example.com/1.png)",
          "",
          "![시안 2](https://example.com/2.png)",
          "",
          "![시안 3](https://example.com/3.png)",
        ].join("\n")}
        cwd={undefined}
      />,
    );

    expect(markup).toContain('data-markdown-image-gallery="true"');
    expect(markup).toContain('data-markdown-image-count="3"');
    expect(markup).toContain("grid-cols-2 sm:grid-cols-3");
  });

  it("does not wrap a single markdown image in a gallery grid", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown text="![단일 이미지](https://example.com/only.png)" cwd={undefined} />,
    );

    expect(markup).not.toContain('data-markdown-image-gallery="true"');
  });
});
