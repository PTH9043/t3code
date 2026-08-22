import { assert, describe, it } from "@effect/vitest";

import { groupByRecency, localDaysAgo, recencyGroupLabel } from "./recencyGroups";

const NOW = new Date(2026, 7, 20, 11, 0, 0); // 2026-08-20 11:00 local

const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour).toISOString();

describe("recencyGroups", () => {
  it("counts whole local days, so late-evening records read as yesterday", () => {
    const lateYesterday = new Date(2026, 7, 19, 23, 50);
    assert.equal(localDaysAgo(lateYesterday, NOW), 1);
    assert.equal(recencyGroupLabel(lateYesterday, NOW), "어제");

    const earlyToday = new Date(2026, 7, 20, 0, 5);
    assert.equal(localDaysAgo(earlyToday, NOW), 0);
    assert.equal(recencyGroupLabel(earlyToday, NOW), "오늘");
  });

  it("keeps the last three days open and folds everything older", () => {
    const items = [
      { id: "today", at: at(2026, 8, 20) },
      { id: "yesterday", at: at(2026, 8, 19) },
      { id: "two-days", at: at(2026, 8, 18) },
      { id: "three-days", at: at(2026, 8, 17) },
      { id: "four-days", at: at(2026, 8, 16) },
    ];

    const groups = groupByRecency(items, (item) => item.at, NOW);

    assert.deepEqual(
      groups.map((group) => [group.label, group.collapsedByDefault]),
      [
        ["오늘", false],
        ["어제", false],
        ["2026-08-18", false],
        // Day three is the first one outside the window, so it folds.
        ["2026-08-17", true],
        ["2026-08-16", true],
      ],
    );
  });

  it("orders newest first and preserves the caller's order inside a day", () => {
    const items = [
      { id: "older-day", at: at(2026, 8, 16) },
      { id: "today-b", at: at(2026, 8, 20, 9) },
      { id: "today-a", at: at(2026, 8, 20, 15) },
    ];

    const groups = groupByRecency(items, (item) => item.at, NOW);

    assert.deepEqual(
      groups.map((group) => group.key),
      ["2026-08-20", "2026-08-16"],
    );
    // Sorting is the caller's business — grouping must not reshuffle a day.
    assert.deepEqual(
      groups[0]?.items.map((item) => item.id),
      ["today-b", "today-a"],
    );
  });

  it("keeps undated records in their own folded group at the end", () => {
    const items = [
      { id: "dated", at: at(2026, 8, 20) },
      { id: "null", at: null },
      { id: "garbage", at: "not-a-date" },
    ];

    const groups = groupByRecency(items, (item) => item.at, NOW);

    assert.deepEqual(
      groups.map((group) => group.key),
      ["2026-08-20", "unknown"],
    );
    const unknown = groups[1];
    assert.equal(unknown?.label, "날짜 없음");
    assert.isTrue(unknown?.collapsedByDefault);
    // Dropping them would hide records the person may be looking for.
    assert.deepEqual(
      unknown?.items.map((item) => item.id),
      ["null", "garbage"],
    );
  });

  it("honours a caller-supplied window", () => {
    const items = [{ id: "yesterday", at: at(2026, 8, 19) }];

    const oneDay = groupByRecency(items, (item) => item.at, NOW, 1);
    assert.isTrue(oneDay[0]?.collapsedByDefault);

    const twoDays = groupByRecency(items, (item) => item.at, NOW, 2);
    assert.isFalse(twoDays[0]?.collapsedByDefault);
  });
});
