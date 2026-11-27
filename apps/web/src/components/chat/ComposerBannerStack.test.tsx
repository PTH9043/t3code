import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const clicks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../ui/button", () => ({
  Button: (props: { "aria-label": string; onClick: () => void }) => {
    clicks.set(props["aria-label"], props.onClick);
    return <button aria-label={props["aria-label"]} />;
  },
}));

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

const banner = (
  id: string,
  variant: ComposerBannerStackItem["variant"] = "warning",
): ComposerBannerStackItem => ({
  id,
  variant,
  icon: <span aria-hidden="true">!</span>,
  title: `${id} warning`,
});

describe("ComposerBannerStack", () => {
  it("closes the restart notice on click while leaving the actionable banner alone", () => {
    const dismiss = vi.fn();
    const dismissError = vi.fn();
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          {
            ...banner("restart"),
            onDismiss: dismiss,
            dismissImmediately: true,
            dismissLabel: "중단 알림 닫기",
          },
          { ...banner("recovery", "error"), onDismiss: dismissError, dismissLabel: "오류 닫기" },
        ]}
      />,
    );
    expect(markup).toContain("중단 알림 닫기");
    clicks.get("중단 알림 닫기")!();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(dismissError).not.toHaveBeenCalled();
  });

  it("keeps expanded banners in layout flow so surrounding content moves out of their way", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack items={[banner("front"), banner("stacked")]} />,
    );

    const expandedItems = markup.match(
      /<div data-composer-banner-stack-expanded-items="true" class="([^"]+)">/,
    );

    expect(expandedItems?.[1]).toContain("grid-rows-[0fr]");
    expect(expandedItems?.[1]).toContain("group-hover/banner-stack:grid-rows-[1fr]");
    expect(expandedItems?.[1]).toContain("z-20");
    expect(expandedItems?.[1]).not.toContain("absolute");
    expect(markup.indexOf("front warning")).toBeLessThan(markup.indexOf("stacked warning"));
    expect(markup).toContain("invisible pointer-events-none");
    expect(markup).toContain("group-focus-within/banner-stack:visible");
  });

  it("colors the collapsed stack cap by the hidden banner's variant, not a fixed warning", () => {
    const neutralBehind = renderToStaticMarkup(
      <ComposerBannerStack items={[banner("front", "default"), banner("stacked", "default")]} />,
    );
    expect(neutralBehind).toContain("border-border");
    expect(neutralBehind).not.toContain("border-warning/24");

    const warningBehind = renderToStaticMarkup(
      <ComposerBannerStack items={[banner("front", "default"), banner("stacked", "warning")]} />,
    );
    expect(warningBehind).toContain("border-warning/24");
  });

  it("spans the composer column instead of a fixed width", () => {
    const markup = renderToStaticMarkup(<ComposerBannerStack items={[banner("front")]} />);
    expect(markup.startsWith('<div class="group/banner-stack mx-auto mb-2">')).toBe(true);
    expect(markup).not.toContain("max-w-3xl");
  });

  it("does not render an expandable region for a single banner", () => {
    const markup = renderToStaticMarkup(<ComposerBannerStack items={[banner("front")]} />);

    expect(markup).not.toContain("data-composer-banner-stack-expanded-items");
    expect(markup).toContain("alert-glass");
    expect(markup).toContain('data-variant="warning"');
    expect(markup).toContain("transform:none");
    expect(markup).not.toContain("will-change:transform");
  });

  it("applies item-specific surface and action layout classes", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          {
            ...banner("branch"),
            className: "branch-surface",
            actionClassName: "branch-actions",
            actions: <button type="button">Repair</button>,
          },
        ]}
      />,
    );

    expect(markup).toContain("branch-surface");
    expect(markup).toContain("branch-actions");
  });
});
