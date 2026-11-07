// Run: npm test   (node --test, no extra dependencies; Node strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline, indexToDay } from "../src/timeline.ts";

/** A /api/images/timeline answer for `dayAt[i]` = day of the image at list position i. */
function fromPositions(dayAt) {
  const days = new Map();
  const runs = [];
  dayAt.forEach((day, i) => {
    const key = day ?? "unknown";
    const d = days.get(key);
    if (d) d.count += 1;
    else days.set(key, { day: key, count: 1, first_index: i });
    if (i === 0 || (dayAt[i - 1] ?? "unknown") !== key) runs.push([i, key]);
  });
  return { days: [...days.values()], runs, total: dayAt.length };
}

const repeat = (day, n) => Array(n).fill(day);

// Newest first. Two stray imported rows: one 2024-10-02 row sits among
// 2025-09-23 images, one 2025-02-07 row among 2026-01-15 images.
const positions = [
  ...repeat("2026-01-15", 5),
  "2025-02-07",
  ...repeat("2026-01-15", 4),
  ...repeat("2025-09-23", 6),
  "2024-10-02",
  ...repeat("2025-09-23", 3),
  null,
  ...repeat("2025-02-07", 8),
  ...repeat("2024-10-02", 7),
];

test("indexToDay returns the day of the image at every position, strays included", () => {
  const timeline = buildTimeline(fromPositions(positions));
  positions.forEach((day, i) => {
    assert.equal(indexToDay(timeline, i)?.day ?? null, day, `position ${i}`);
  });
  // Past the end: the last run.
  assert.equal(indexToDay(timeline, positions.length + 10)?.day, "2024-10-02");
});

test("month / year anchors sit at the longest stretch, not at a stray's first_index", () => {
  const timeline = buildTimeline(fromPositions(positions));
  // first_index of 2024-10 is the stray at 16; its images are from 29 on.
  assert.equal(timeline.byDay.get("2024-10-02").first_index, 16);
  assert.equal(timeline.monthAnchor.get("2024-10"), 29);
  // 2025-02's first_index is the stray at 5.
  assert.equal(timeline.byDay.get("2025-02-07").first_index, 5);
  assert.equal(timeline.monthAnchor.get("2025-02"), 21);
  assert.equal(timeline.monthAnchor.get("2025-09"), 10);
  assert.equal(timeline.monthAnchor.get("2026-01"), 0);
  // 2025 runs from 10 to 28; the 2024 stray (16) and the undated row (20)
  // do not split it, so the year tick is where 2025 starts.
  assert.equal(timeline.yearAnchor.get(2025), 10);
  assert.equal(timeline.yearAnchor.get(2024), 29);
  assert.equal(timeline.yearAnchor.get(2026), 0);
});

test("empty result", () => {
  const timeline = buildTimeline({ days: [], runs: [], total: 0 });
  assert.equal(indexToDay(timeline, 0), null);
});
