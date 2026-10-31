import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewChromeRow } from "./PreviewChromeRow";

describe("PreviewChromeRow", () => {
  it("shows the complete URL while the address bar is not focused", () => {
    const markup = renderToStaticMarkup(
      <PreviewChromeRow
        url="https://example.com/dashboard?mode=edit&tab=1#notes"
        loading={false}
        loadProgress={0}
        canGoBack={false}
        canGoForward={false}
        refreshDisabled={false}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onRefresh={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain('value="https://example.com/dashboard?mode=edit&amp;tab=1#notes"');
  });

  it("exposes the separate preview and its state directly in the toolbar", () => {
    const props = {
      url: "https://example.com",
      loading: false,
      loadProgress: 0,
      canGoBack: false,
      canGoForward: false,
      refreshDisabled: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onRefresh: vi.fn(),
      onSubmit: vi.fn(),
      onNativePreview: vi.fn(),
    };
    const closed = renderToStaticMarkup(<PreviewChromeRow {...props} nativePreviewOpen={false} />);
    const open = renderToStaticMarkup(<PreviewChromeRow {...props} nativePreviewOpen />);

    expect(closed).toContain('aria-label="별도 미리보기 열기"');
    expect(open).toContain('aria-label="별도 미리보기 닫기"');
  });
});
