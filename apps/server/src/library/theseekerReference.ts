/**
 * Parser for one "더씨커 레퍼런스" (https://ref.theseeker.io) reference page.
 *
 * The site is server-rendered with TanStack Router, which streams each route's
 * loader data into the page as a seroval payload (`post:$R[n]={id:…}`). That
 * payload carries the structured AI analysis — Korean and English title,
 * summary, description, per-image captions, named palette colours, mood and
 * labelled tags — most of which the visible markup does not show (tag labels
 * sit in attributes, palette names nowhere). So this reads the payload's
 * fields by key rather than scraping text, and never evaluates it: the
 * payload is third-party JavaScript.
 */

export const SEEKER_ORIGIN = "https://ref.theseeker.io";

export interface SeekerReference {
  readonly id: number;
  readonly tweetUrl: string | null;
  readonly postText: string | null;
  readonly postedAt: string | null;
  readonly author: { readonly handle: string; readonly name: string } | null;
  readonly title: string;
  readonly titleEn: string | null;
  readonly summary: string | null;
  readonly summaryEn: string | null;
  readonly description: string | null;
  readonly descriptionEn: string | null;
  readonly category: string | null;
  readonly vibe: ReadonlyArray<string>;
  readonly palette: ReadonlyArray<{ readonly hex: string; readonly name: string }>;
  readonly tags: ReadonlyArray<{
    readonly slug: string;
    readonly label: string;
    readonly facet: string;
  }>;
  readonly captions: ReadonlyArray<string>;
  readonly captionsEn: ReadonlyArray<string>;
  readonly confidence: number | null;
  readonly analyzedAt: string | null;
}

const STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"`;

/** Decode a double-quoted JavaScript string literal (seroval's escaping). */
export function decodeJsStringLiteral(literal: string): string {
  let out = "";
  for (let index = 1; index < literal.length - 1; index++) {
    const char = literal[index] ?? "";
    if (char !== "\\") {
      out += char;
      continue;
    }
    index += 1;
    const next = literal[index] ?? "";
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        out += "\0";
        break;
      case "x":
        out += String.fromCharCode(Number.parseInt(literal.slice(index + 1, index + 3), 16));
        index += 2;
        break;
      case "u":
        if (literal[index + 1] === "{") {
          const close = literal.indexOf("}", index);
          out += String.fromCodePoint(Number.parseInt(literal.slice(index + 2, close), 16));
          index = close;
        } else {
          out += String.fromCharCode(Number.parseInt(literal.slice(index + 1, index + 5), 16));
          index += 4;
        }
        break;
      default:
        out += next;
    }
  }
  return out;
}

function stringField(block: string, key: string): string | null {
  const match = new RegExp(String.raw`[{,]${key}:(${STRING_LITERAL})`, "u").exec(block);
  const literal = match?.[1];
  return literal === undefined ? null : decodeJsStringLiteral(literal);
}

function allStringFields(block: string, key: string): ReadonlyArray<string> {
  const values: string[] = [];
  for (const match of block.matchAll(
    new RegExp(String.raw`[{,]${key}:(${STRING_LITERAL})`, "gu"),
  )) {
    const literal = match[1];
    if (literal !== undefined) values.push(decodeJsStringLiteral(literal));
  }
  return values;
}

function stringArrayField(block: string, key: string): ReadonlyArray<string> {
  const match = new RegExp(
    String.raw`[{,]${key}:\$R\[\d+\]=\[((?:${STRING_LITERAL},?)*)\]`,
    "u",
  ).exec(block);
  const body = match?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(new RegExp(STRING_LITERAL, "gu"))].map((literal) =>
    decodeJsStringLiteral(literal[0]),
  );
}

const nonEmpty = (value: string | null): string | null =>
  value === null || value.trim().length === 0 ? null : value.trim();

/**
 * Read the reference a `/r/<id>` page carries, or null when the page holds no
 * reference (not found, or a layout this parser does not recognise).
 */
export function parseSeekerReferencePage(
  html: string,
  expectedId?: number,
): SeekerReference | null {
  const head = /post:\$R\[\d+\]=\{id:(\d+),/u.exec(html);
  if (head === null) return null;
  const id = Number(head[1]);
  if (!Number.isSafeInteger(id) || (expectedId !== undefined && id !== expectedId)) return null;

  const postStart = head.index;
  const similarAt = html.indexOf("},similar:", postStart);
  const post = html.slice(postStart, similarAt > postStart ? similarAt + 1 : postStart + 200_000);

  const analysisAt = post.indexOf("analysis:$R[");
  const tagsAt = analysisAt >= 0 ? post.indexOf(",tags:$R[", analysisAt) : -1;
  const statusAt = post.indexOf(",analysisStatus:");
  const detailAt = post.indexOf("analysisDetail:$R[");

  const identity = post.slice(0, analysisAt >= 0 ? analysisAt : post.length);
  const analysis =
    analysisAt >= 0
      ? post.slice(
          analysisAt,
          tagsAt > analysisAt ? tagsAt : statusAt > analysisAt ? statusAt : undefined,
        )
      : "";
  const tagsBlock = tagsAt >= 0 ? post.slice(tagsAt, statusAt > tagsAt ? statusAt : undefined) : "";
  const detail = detailAt >= 0 ? post.slice(detailAt) : "";

  const authorMatch = new RegExp(
    String.raw`author:\$R\[\d+\]=\{handle:(${STRING_LITERAL}),name:(${STRING_LITERAL})`,
    "u",
  ).exec(identity);
  const author =
    authorMatch?.[1] !== undefined && authorMatch[2] !== undefined
      ? {
          handle: decodeJsStringLiteral(authorMatch[1]),
          name: decodeJsStringLiteral(authorMatch[2]),
        }
      : null;

  const postText = nonEmpty(stringField(identity, "text"));
  const title =
    nonEmpty(stringField(analysis, "title")) ??
    nonEmpty(postText?.split("\n")[0]?.slice(0, 120) ?? null);
  if (title === null) return null;

  const palette = [
    ...analysis.matchAll(
      new RegExp(String.raw`\{hex:(${STRING_LITERAL}),name:(${STRING_LITERAL})\}`, "gu"),
    ),
  ].flatMap((match) =>
    match[1] !== undefined && match[2] !== undefined
      ? [{ hex: decodeJsStringLiteral(match[1]), name: decodeJsStringLiteral(match[2]) }]
      : [],
  );
  const tags = [
    ...tagsBlock.matchAll(
      new RegExp(
        String.raw`\{slug:(${STRING_LITERAL}),label:(${STRING_LITERAL}),facet:(${STRING_LITERAL})\}`,
        "gu",
      ),
    ),
  ].flatMap((match) =>
    match[1] !== undefined && match[2] !== undefined && match[3] !== undefined
      ? [
          {
            slug: decodeJsStringLiteral(match[1]),
            label: decodeJsStringLiteral(match[2]),
            facet: decodeJsStringLiteral(match[3]),
          },
        ]
      : [],
  );
  const confidenceMatch = /[{,]confidence:([0-9.]+)/u.exec(detail);

  return {
    id,
    tweetUrl: nonEmpty(stringField(identity, "url")),
    postText,
    postedAt: nonEmpty(stringField(identity, "postedAt")),
    author,
    title,
    titleEn: nonEmpty(stringField(detail, "titleEn")),
    summary: nonEmpty(stringField(analysis, "summary")),
    summaryEn: nonEmpty(stringField(detail, "summaryEn")),
    description: nonEmpty(stringField(detail, "description")),
    descriptionEn: nonEmpty(stringField(detail, "descriptionEn")),
    category: nonEmpty(stringField(analysis, "category")),
    vibe: stringArrayField(analysis, "vibe"),
    palette,
    tags,
    captions: allStringFields(detail, "caption"),
    captionsEn: allStringFields(detail, "captionEn"),
    confidence: confidenceMatch?.[1] === undefined ? null : Number(confidenceMatch[1]),
    analyzedAt: nonEmpty(stringField(detail, "analyzedAt")),
  };
}

export interface SeekerLibraryDocument {
  readonly itemId: string;
  readonly sourceRef: string;
  readonly sourceUrl: string;
  readonly title: string;
  /** Korean-first text an agent reads: what the design is and how it is built. */
  readonly content: string;
  /** English analysis and the original post, indexed but not injected. */
  readonly searchExtra: string;
  readonly tags: ReadonlyArray<string>;
  readonly category: string | null;
  readonly author: string | null;
  readonly publishedAt: string | null;
}

/** Shape a parsed reference into the library's stored document. */
export function toSeekerLibraryDocument(reference: SeekerReference): SeekerLibraryDocument {
  const sourceUrl = `${SEEKER_ORIGIN}/r/${reference.id}`;
  const captions = reference.captions.filter((caption) => caption !== reference.summary);
  const lines = [
    reference.summary,
    reference.description === null ? null : `설명: ${reference.description}`,
    captions.length === 0 ? null : `이미지: ${captions.join(" / ")}`,
    [
      reference.category === null ? null : `카테고리: ${reference.category}`,
      reference.vibe.length === 0 ? null : `스타일: ${reference.vibe.join(", ")}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ") || null,
    reference.tags.length === 0
      ? null
      : `태그: ${reference.tags
          .map((tag) => (tag.label === tag.slug ? tag.slug : `${tag.label}(${tag.slug})`))
          .join(" · ")}`,
    reference.palette.length === 0
      ? null
      : `팔레트: ${reference.palette.map((color) => `${color.hex} ${color.name}`).join(" · ")}`,
    reference.author === null
      ? null
      : `작가: ${reference.author.name} (@${reference.author.handle})${
          reference.postedAt === null ? "" : ` · 게시 ${reference.postedAt.slice(0, 10)}`
        }`,
    reference.tweetUrl === null ? null : `원본: ${reference.tweetUrl}`,
    `레퍼런스: ${sourceUrl}`,
  ].filter((line): line is string => line !== null && line.length > 0);

  const tags = [
    ...new Set(
      [
        reference.category,
        ...reference.vibe,
        ...reference.tags.flatMap((tag) => [tag.slug, tag.label]),
      ].filter((tag): tag is string => tag !== null && tag.length > 0),
    ),
  ];

  return {
    itemId: `theseeker-${reference.id}`,
    sourceRef: String(reference.id),
    sourceUrl,
    title: reference.title,
    content: lines.join("\n"),
    searchExtra: [
      reference.titleEn,
      reference.summaryEn,
      reference.descriptionEn,
      ...reference.captionsEn,
      reference.postText,
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join("\n"),
    tags,
    category: reference.category,
    author: reference.author === null ? null : `@${reference.author.handle}`,
    publishedAt: reference.postedAt,
  };
}
