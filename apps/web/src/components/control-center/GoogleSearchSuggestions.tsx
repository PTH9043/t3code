import { useEffect, useRef, useState } from "react";

/** Google supplies this HTML/CSS; reject active or external content before mounting it. */
export function isSafeGoogleSearchSuggestions(html: string): boolean {
  if (!html || html.length > 100_000) return false;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const allowedTags = new Set([
    "HTML",
    "HEAD",
    "BODY",
    "STYLE",
    "DIV",
    "SPAN",
    "A",
    "SVG",
    "PATH",
    "CIRCLE",
  ]);
  const allowedAttributes = new Set([
    "class",
    "href",
    "target",
    "rel",
    "width",
    "height",
    "viewbox",
    "fill",
    "xmlns",
    "d",
    "fill-rule",
    "clip-rule",
    "cx",
    "cy",
    "r",
    "aria-label",
    "role",
  ]);
  for (const element of parsed.querySelectorAll("*")) {
    if (!allowedTags.has(element.tagName.toUpperCase())) return false;
    for (const attribute of element.attributes) {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) return false;
      if (attribute.name.toLowerCase() === "href") {
        try {
          const url = new URL(attribute.value);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            !["vertexaisearch.cloud.google.com", "www.google.com", "google.com"].includes(
              url.hostname,
            )
          )
            return false;
        } catch {
          return false;
        }
      }
    }
  }
  for (const style of parsed.querySelectorAll("style")) {
    if (/@import|url\s*\(|expression\s*\(|position\s*:\s*fixed|\\/i.test(style.textContent ?? ""))
      return false;
  }
  return parsed.querySelector("a[href]") !== null;
}

export function GoogleSearchSuggestions({
  html,
  onValidated,
}: {
  html: string;
  onValidated: (valid: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [valid, setValid] = useState(false);
  useEffect(() => {
    const safe = isSafeGoogleSearchSuggestions(html);
    setValid(safe);
    onValidated(safe);
    if (safe && ref.current) {
      const shadow = ref.current.shadowRoot ?? ref.current.attachShadow({ mode: "open" });
      shadow.innerHTML = html;
    }
  }, [html, onValidated]);
  return (
    <div ref={ref} aria-label="Google 검색 제안">
      {!valid ? "검색 제안을 안전하게 표시할 수 없습니다." : null}
    </div>
  );
}
