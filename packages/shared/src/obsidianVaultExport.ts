/**
 * Obsidian Vault Compatibility Exporter (inspired by obsidianmd/obsidian-skills):
 * Formats T3 Workspace Knowledge items into clean Obsidian Markdown with YAML
 * frontmatter properties, `[[wikilink]]` preservation, callout blocks, and
 * companion `.base` database view definitions.
 */

export interface ObsidianExportNoteInput {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly tags?: ReadonlyArray<string>;
  readonly sourceUrls?: ReadonlyArray<string>;
  readonly status?: string;
  readonly updatedAt: string;
  readonly relatedTitles?: ReadonlyArray<string>;
}

function yamlEscape(value: string): string {
  return JSON.stringify(value);
}

export function renderObsidianVaultNote(input: ObsidianExportNoteInput): string {
  const tags = [
    ...new Set((input.tags ?? []).map((t) => t.trim().replace(/^#/, "")).filter(Boolean)),
  ];
  const frontmatterLines = [
    "---",
    `t3_id: ${yamlEscape(input.id)}`,
    `title: ${yamlEscape(input.title)}`,
    `status: ${yamlEscape(input.status ?? "active")}`,
    `updated: ${yamlEscape(input.updatedAt)}`,
    ...(tags.length > 0 ? ["tags:", ...tags.map((t) => `  - ${yamlEscape(t)}`)] : ["tags: []"]),
    ...(input.sourceUrls && input.sourceUrls.length > 0
      ? ["sources:", ...input.sourceUrls.map((u) => `  - ${yamlEscape(u)}`)]
      : []),
    "---",
  ];

  const sections: string[] = [frontmatterLines.join("\n"), "", `# ${input.title}`, ""];

  if (input.sourceUrls && input.sourceUrls.length > 0) {
    sections.push("> [!info] 출처", ...input.sourceUrls.map((u) => `> - ${u}`), "");
  }

  sections.push(input.content.trim());

  if (input.relatedTitles && input.relatedTitles.length > 0) {
    sections.push(
      "",
      "## 관련 문서",
      ...input.relatedTitles.map((rel) => `- [[${rel.replace(/[[\]|]/g, "").trim()}]]`),
    );
  }

  return `${sections.join("\n")}\n`;
}

/** Generates an Obsidian Bases (`.base`) YAML view for exported T3 knowledge notes. */
export function renderObsidianBaseView(folderName: string): string {
  return [
    "filters:",
    "  and:",
    `    - file.inFolder(${yamlEscape(folderName)})`,
    "views:",
    "  - type: table",
    `    name: ${yamlEscape("T3 지식 원장")}`,
    "    order:",
    "      - file.name",
    "      - status",
    "      - tags",
    "      - updated",
    "",
  ].join("\n");
}
