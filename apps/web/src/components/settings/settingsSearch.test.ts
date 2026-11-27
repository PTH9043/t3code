import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches only setting titles", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("work")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchSettings("중단 알림 표시 시간")).toContainEqual({
      id: "background-watch-notice",
      title: "감시 중단 알림 표시 시간",
      to: "/settings/general",
    });
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "자동 줄 바꿈" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "보관된 대화" });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("테마")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("자동 줄 바꿈")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("실행 환경 표시")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance",
    });
    expect(searchSettings("대화방 좌우 여백")[0]).toMatchObject({
      id: "setting-chat-horizontal-inset",
      to: "/settings/appearance",
    });
    expect(searchSettings("폭")[0]).toMatchObject({
      id: "setting-chat-horizontal-inset",
      to: "/settings/appearance",
    });
  });

  it("routes automatic update settings to general and program permissions to permissions", () => {
    expect(searchSettings("자동 다운로드")[0]).toMatchObject({
      id: "automatic-update-download",
      to: "/settings/general",
    });
    expect(searchSettings("자동 설치")[0]).toMatchObject({
      id: "automatic-update-install",
      to: "/settings/general",
    });
    expect(searchSettings("프로그램 자동 시작")[0]).toMatchObject({
      id: "workspace-program-auto-start",
      to: "/settings/permissions",
    });
    expect(searchSettings("수정 검증 후 자동 재시작")[0]).toMatchObject({
      id: "workspace-program-auto-restart-after-repair",
      to: "/settings/permissions",
    });
  });
});
