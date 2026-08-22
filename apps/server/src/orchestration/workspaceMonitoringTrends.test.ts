import { expect, it } from "vite-plus/test";

import {
  SampleRing,
  evaluateTrend,
  percentile,
  slopePerMinute,
} from "./workspaceMonitoringTrends.ts";

const MIN = 60_000;
const now = Date.parse("2026-08-21T12:00:00.000Z");

function ringOf(points: ReadonlyArray<readonly [minutesAgo: number, value: number]>): SampleRing {
  const ring = new SampleRing(100);
  for (const [minutesAgo, value] of [...points].sort((a, b) => b[0] - a[0])) {
    ring.push({ at: now - minutesAgo * MIN, value });
  }
  return ring;
}

it("slope is per minute and needs three points", () => {
  expect(
    slopePerMinute([
      { at: 0, value: 1 },
      { at: MIN, value: 2 },
    ]),
  ).toBeNull();
  expect(
    slopePerMinute([
      { at: 0, value: 100 },
      { at: MIN, value: 110 },
      { at: 2 * MIN, value: 120 },
    ]),
  ).toBeCloseTo(10);
});

it("percentile picks the nearest-rank value", () => {
  expect(percentile([], 0.95)).toBeNull();
  expect(percentile([5, 1, 9, 3], 0.5)).toBe(3);
  expect(percentile([5, 1, 9, 3], 0.95)).toBe(9);
});

it("threshold judges the window mean, except counting metrics which use the latest value", () => {
  const cpu = {
    targetIndex: 0,
    metric: "cpu",
    trend: "threshold",
    windowMin: 5,
    limit: 80,
  } as const;
  expect(
    evaluateTrend(
      cpu,
      ringOf([
        [4, 95],
        [2, 70],
        [0, 60],
      ]),
      now,
    ),
  ).toMatchObject({ anomalous: false });
  expect(
    evaluateTrend(
      cpu,
      ringOf([
        [4, 95],
        [2, 90],
        [0, 85],
      ]),
      now,
    ),
  ).toMatchObject({
    anomalous: true,
    direction: "over",
  });
  const health = { ...cpu, metric: "health", limit: 3 } as const;
  // Older failures do not count; only the latest consecutive-failure count does.
  expect(
    evaluateTrend(
      health,
      ringOf([
        [4, 5],
        [0, 1],
      ]),
      now,
    ),
  ).toMatchObject({ anomalous: false });
  expect(
    evaluateTrend(
      health,
      ringOf([
        [4, 0],
        [0, 3],
      ]),
      now,
    ),
  ).toMatchObject({ anomalous: true });
});

it("slope flags a steady climb and ignores samples outside the window", () => {
  const memory = {
    targetIndex: 0,
    metric: "memory",
    trend: "slope",
    windowMin: 10,
    limit: 1_000,
  } as const;
  const climbing = ringOf([
    [9, 0],
    [6, 3_000],
    [3, 6_000],
    [0, 9_000],
  ]);
  expect(evaluateTrend(memory, climbing, now)).toMatchObject({ anomalous: true, direction: "up" });
  const flat = ringOf([
    [60, 0],
    [9, 50_000],
    [5, 50_100],
    [0, 50_050],
  ]);
  expect(evaluateTrend(memory, flat, now)).toMatchObject({ anomalous: false });
  expect(
    evaluateTrend(
      memory,
      ringOf([
        [1, 1],
        [0, 2],
      ]),
      now,
    ),
  ).toBeNull();
});

it("p95-vs-baseline compares the current window to the one before it", () => {
  const latency = {
    targetIndex: 0,
    metric: "latency",
    trend: "p95-vs-baseline",
    windowMin: 5,
    limit: 1.5,
  } as const;
  const regressed = ringOf([
    [9, 100],
    [8, 110],
    [7, 105],
    [6, 100],
    [4, 200],
    [3, 210],
    [1, 190],
    [0, 205],
  ]);
  expect(evaluateTrend(latency, regressed, now)).toMatchObject({
    anomalous: true,
    direction: "up",
  });
  const stable = ringOf([
    [9, 100],
    [8, 110],
    [7, 105],
    [6, 100],
    [4, 100],
    [3, 120],
    [1, 95],
    [0, 105],
  ]);
  expect(evaluateTrend(latency, stable, now)).toMatchObject({ anomalous: false });
  // No baseline yet → no verdict rather than a false alarm on startup.
  expect(
    evaluateTrend(
      latency,
      ringOf([
        [4, 200],
        [3, 210],
        [0, 205],
      ]),
      now,
    ),
  ).toBeNull();
});
