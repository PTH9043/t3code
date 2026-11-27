import { describe, expect, it } from "vite-plus/test";
import { WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import type { DashboardRow } from "./dashboardSelection";
import { parseStructuredKnowledgeContent } from "./KnowledgeReader";
import { groupKnowledgeRowsBySource } from "./KnowledgeRows";
import { groupConsecutiveWorkLogEntries } from "../chat/ThreadTurnViewer";
import type { WorkLogEntry } from "../../session-logic";

describe("parseStructuredKnowledgeContent (ERR-19)", () => {
  it("parses raw JSON objects into structured tree data and clean markdown", () => {
    const raw = JSON.stringify({
      summary: "배포 체크리스트\\n1단계 확인",
      checks: ["lint", "test"],
    });
    const parsed = parseStructuredKnowledgeContent(raw);
    expect(parsed.isJson).toBe(true);
    expect(parsed.parsed).toEqual({
      summary: "배포 체크리스트\\n1단계 확인",
      checks: ["lint", "test"],
    });
    expect(parsed.readableMarkdown).toContain("배포 체크리스트");
    expect(parsed.readableMarkdown).toContain("- lint");
    expect(parsed.readableMarkdown).not.toContain('{"summary"');
  });

  it("unescapes double-encoded JSON string dumps cleanly", () => {
    const doubleEncoded = JSON.stringify(JSON.stringify({ title: "회고", status: "완료" }));
    const parsed = parseStructuredKnowledgeContent(doubleEncoded);
    expect(parsed.isJson).toBe(true);
    expect(parsed.readableMarkdown).toContain("**title**: 회고");
    expect(parsed.readableMarkdown).toContain("**status**: 완료");
  });

  it("preserves plain markdown content without false JSON classification", () => {
    const md = "# 제목\n\n본문 내용입니다.";
    const parsed = parseStructuredKnowledgeContent(md);
    expect(parsed.isJson).toBe(false);
    expect(parsed.readableMarkdown).toBe(md);
  });
});

describe("groupKnowledgeRowsBySource (ERR-47)", () => {
  const makeRow = (id: string, title: string, promptUses = 0): DashboardRow => ({
    revisionSequence: 1,
    id: WorkspaceKnowledgeItemId.make(id),
    title,
    kind: "rag-source",
    status: "active",
    promptUses,
    lastUsedAt: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    contentHash: `hash-${id}`,
    supersededBy: null,
  });

  it("groups duplicate items originating from the same conversation thread", () => {
    const rows: DashboardRow[] = [
      makeRow("conversation-0123456789abcdef-aaa", "대화 입력 · 테마 개선", 2),
      makeRow("conversation-0123456789abcdef-bbb", "대화 입력 · 테마 개선", 1),
      makeRow("manual-note-1", "단독 문서", 0),
    ];
    const groups = groupKnowledgeRowsBySource(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[0]?.label).toContain("테마 개선");
    expect(groups[1]?.items).toHaveLength(1);
  });
});

describe("groupConsecutiveWorkLogEntries (ERR-40)", () => {
  const makeEntry = (id: string, label: string, createdAt: string): WorkLogEntry => ({
    id,
    createdAt,
    label,
    tone: "tool",
    toolTitle: label,
  });

  it("collapses consecutive identical tool activity entries into counted runs", () => {
    const entries: WorkLogEntry[] = [
      makeEntry("1", "파일 읽기", "2026-11-21T01:00:00.000Z"),
      makeEntry("2", "파일 읽기", "2026-11-21T01:00:01.000Z"),
      makeEntry("3", "파일 읽기", "2026-11-21T01:00:02.000Z"),
      makeEntry("4", "명령 실행", "2026-11-21T01:00:03.000Z"),
      makeEntry("5", "파일 읽기", "2026-11-21T01:00:04.000Z"),
    ];
    const runs = groupConsecutiveWorkLogEntries(entries);
    expect(runs).toHaveLength(3);
    expect(runs[0]?.entries).toHaveLength(3);
    expect(runs[0]?.groupLabel).toBe("파일 읽기");
    expect(runs[1]?.entries).toHaveLength(1);
    expect(runs[2]?.entries).toHaveLength(1);
  });
});
