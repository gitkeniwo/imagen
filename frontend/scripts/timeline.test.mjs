// Run: npm test   (node --test, no extra dependencies; Node strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTimeline,
  indexInPinned,
  indexToDay,
  phoneRulerTicks,
} from "../src/timeline.ts";

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
  assert.deepEqual(phoneRulerTicks(timeline, 0, 300), []);
});

test("pinned drafts form a non-calendar prefix before the dated runs", () => {
  const base = fromPositions(positions);
  const timeline = buildTimeline({
    ...base,
    pinned: 2,
    days: base.days.map((day) => ({ ...day, first_index: day.first_index + 2 })),
    runs: base.runs.map(([start, day]) => [start + 2, day]),
    total: base.total + 2,
  });
  assert.equal(timeline.pinned, 2);
  assert.equal(indexInPinned(timeline, 0), true);
  assert.equal(indexInPinned(timeline, 1), true);
  assert.equal(indexInPinned(timeline, 2), false);
  assert.equal(indexToDay(timeline, 0), null);
  assert.equal(indexToDay(timeline, 1), null);
  assert.equal(indexToDay(timeline, 2)?.day, positions[0]);
  assert.deepEqual(timeline.runStarts.slice(0, 2), [2, 7]);
});

function monthTimeline(yearCount, monthCount = 12, imagesPerMonth = 50) {
  const days = [];
  const anchors = new Map();
  const yearAnchors = new Map();
  let index = 0;
  let year = 2026;
  for (let y = 0; y < yearCount; y++, year--) {
    yearAnchors.set(year, index);
    for (let m = monthCount - 1; m >= 0; m--) {
      const key = `${year}-${String(m + 1).padStart(2, "0")}`;
      days.push({
        day: `${key}-15`,
        count: imagesPerMonth,
        first_index: index,
      });
      anchors.set(key, index);
      index += imagesPerMonth;
    }
  }
  const timeline = buildTimeline({ days, runs: [], total: index });
  timeline.monthAnchor = anchors;
  timeline.yearAnchor = yearAnchors;
  return timeline;
}

test("phone ruler keeps every month at normal density", () => {
  const timeline = monthTimeline(2);
  const ticks = phoneRulerTicks(timeline, 2 * 12 * 50, 300);
  assert.equal(ticks.filter((tick) => tick.kind === "month").length, 24);
  assert.equal(ticks.filter((tick) => tick.kind === "year").length, 2);
  assert.equal(ticks.filter((tick) => tick.label).length, 2);
});

test("phone ruler does not thin months for one partial month at the edge", () => {
  const timeline = monthTimeline(2);
  timeline.monthAnchor.set("2026-10", 19);
  const ticks = phoneRulerTicks(timeline, 2 * 12 * 50, 300);
  assert.equal(ticks.filter((tick) => tick.kind === "month").length, 24);
});

test("phone ruler falls back to quarter months when months are dense", () => {
  const yearCount = 8;
  const total = yearCount * 12 * 50;
  const ticks = phoneRulerTicks(monthTimeline(yearCount), total, 300);
  const months = ticks.filter((tick) => tick.kind === "month");
  assert.equal(months.length, yearCount * 4);
  assert.ok(months.every((tick) => /-(01|04|07|10)$/.test(tick.key)));
});

test("phone ruler drops months and thins year labels when even quarters are dense", () => {
  const yearCount = 36;
  const total = yearCount * 12 * 50;
  const ticks = phoneRulerTicks(monthTimeline(yearCount), total, 300);
  assert.equal(ticks.filter((tick) => tick.kind === "month").length, 0);
  assert.equal(ticks.filter((tick) => tick.kind === "year").length, yearCount);
  assert.equal(ticks.filter((tick) => tick.label).length, yearCount / 2);
});

test("phone ruler keeps the newer year label when two labels would overlap", () => {
  const timeline = monthTimeline(3);
  timeline.yearAnchor = new Map([
    [2026, 0],
    [2025, 5],
    [2024, 200],
  ]);
  const labels = phoneRulerTicks(timeline, 3 * 12 * 50, 300)
    .filter((tick) => tick.kind === "year" && tick.label)
    .map((tick) => tick.label);
  assert.deepEqual(labels, ["2026", "2024"]);
});
