import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isSafeGoogleSearchSuggestions } from "./GoogleSearchSuggestions";

type ElementStub = {
  tagName: string;
  attributes: { name: string; value: string }[];
  textContent?: string;
};

function provideParsedDocument(elements: ElementStub[], hasAnchor = true) {
  vi.stubGlobal(
    "DOMParser",
    class {
      parseFromString() {
        return {
          querySelectorAll: (selector: string) =>
            selector === "style"
              ? elements.filter((element) => element.tagName === "STYLE")
              : elements,
          querySelector: () => (hasAnchor ? {} : null),
        };
      }
    },
  );
}

describe("Google search suggestion validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows Google links but rejects scripts, unsafe links, and external CSS", () => {
    const link = {
      tagName: "A",
      attributes: [{ name: "href", value: "https://www.google.com/search?q=x" }],
    };
    provideParsedDocument([link]);
    expect(isSafeGoogleSearchSuggestions("<a>search</a>")).toBe(true);
    provideParsedDocument([{ tagName: "SCRIPT", attributes: [] }, link]);
    expect(isSafeGoogleSearchSuggestions("<script></script>")).toBe(false);
    provideParsedDocument([
      { ...link, attributes: [{ name: "href", value: "javascript:alert(1)" }] },
    ]);
    expect(isSafeGoogleSearchSuggestions("<a>search</a>")).toBe(false);
    provideParsedDocument([
      { ...link, attributes: [{ name: "href", value: "https://evil.example/" }] },
    ]);
    expect(isSafeGoogleSearchSuggestions("<a>search</a>")).toBe(false);
    provideParsedDocument([
      {
        tagName: "STYLE",
        attributes: [],
        textContent: "div{background:url(https://evil.example)}",
      },
      link,
    ]);
    expect(isSafeGoogleSearchSuggestions("<style></style>")).toBe(false);
    provideParsedDocument([link], false);
    expect(isSafeGoogleSearchSuggestions("<div>no suggestion</div>")).toBe(false);
  });
});
