import {
  findFactStatusBadges,
  type FactStatusBadgeTone,
} from "@t3tools/client-runtime/state/response-style-presentation";
import { badgeVariants } from "./components/ui/badge";
import { cn } from "./lib/utils";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const toneBadgeVariants = {
  success: "success",
  info: "info",
  warning: "warning",
  muted: "outline",
  danger: "error",
} as const satisfies Record<FactStatusBadgeTone, string>;

/**
 * Rehype plugin that turns status tags such as `[확인 완료]` into inline badges. Add it after
 * sanitizing: it only rewrites text nodes, and leaves `code` and `pre` untouched. Each badge
 * keeps its bracket form in `data-markdown-copy`, so copying a selection yields the original.
 */
export function rehypeFactStatusBadges() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children || node.tagName === "code" || node.tagName === "pre") return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return [child];
        }
        const text = child.value;
        const badges = findFactStatusBadges(text);
        if (badges.length === 0) return [child];
        const parts: HastNode[] = [];
        let cursor = 0;
        for (const badge of badges) {
          if (badge.start > cursor) {
            parts.push({ type: "text", value: text.slice(cursor, badge.start) });
          }
          parts.push({
            type: "element",
            tagName: "span",
            properties: {
              className: cn(
                badgeVariants({ variant: toneBadgeVariants[badge.tone] }),
                "align-middle",
              ).split(" "),
              dataFactStatus: badge.tone,
              dataMarkdownCopy: text.slice(badge.start, badge.end),
            },
            children: [{ type: "text", value: badge.label }],
          });
          cursor = badge.end;
        }
        if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
        return parts;
      });
    };
    visit(tree);
  };
}
