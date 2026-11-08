import type { ImageTimeline } from "./api";
import type { Lang } from "./i18n";

/**
 * Library timeline model.
 *
 * The API returns one row per local calendar day, with the day's count and the
 * position of its first image in the current list order. `first_index` is the
 * only ordering information we have, because `created_at` is not guaranteed to
 * follow id order (imported rows). The model below therefore keeps the days in
 * position order for `indexToDay()` and in date order for the jump dialog.
 */

export interface TimelineDay {
  day: string;
  count: number;
  first_index: number;
}

export interface TimelineMonth {
  key: string;
  year: number;
  month: number;
  count: number;
  firstIndex: number;
  days: TimelineDay[];
}

export interface TimelineYear {
  year: number;
  count: number;
  months: TimelineMonth[];
}

export interface Timeline {
  // Valid (YYYY-MM-DD) days in list-position order.
  days: TimelineDay[];
  // Day changes in list order: runStarts[k] is where runDays[k] begins.
  // runDays[k] is null for rows without a usable date.
  runStarts: number[];
  runDays: (TimelineDay | null)[];
  // Where each month / year sits on the scrubber: the start of its longest
  // contiguous stretch in list order, so a few stray rows cannot drag the
  // tick away from where that month's images actually are.
  monthAnchor: Map<string, number>;
  yearAnchor: Map<number, number>;
  // Valid days in calendar order, oldest first (binary search by date).
  byDate: TimelineDay[];
  byDay: Map<string, TimelineDay>;
  // Newest year first; months run January → December.
  years: TimelineYear[];
  total: number;
}

export interface PhoneRulerTick {
  key: string;
  ratio: number;
  kind: "month" | "year";
  label?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Longest interruption (in rows) that does not split a month / year stretch.
const STRAY_ROWS = 2;
const PHONE_TICK_MIN_GAP = 4;
const PHONE_YEAR_LABEL_MIN_GAP = 16;
const pad = (n: number) => String(n).padStart(2, "0");

export function monthKey(year: number, month: number): string {
  return `${year}-${pad(month + 1)}`;
}

export function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Midday avoids DST edges when only the calendar day matters. */
export function dateOfDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

export function buildTimeline(input: ImageTimeline): Timeline {
  const valid = input.days
    .filter((d) => DAY_RE.test(d.day))
    .map((d) => ({ ...d }))
    .sort((a, b) => a.first_index - b.first_index);
  const byDay = new Map(valid.map((d) => [d.day, d]));
  const byDate = [...valid].sort((a, b) => a.day.localeCompare(b.day));

  const years = new Map<number, TimelineYear>();
  for (const d of valid) {
    const year = Number(d.day.slice(0, 4));
    const month = Number(d.day.slice(5, 7)) - 1;
    let y = years.get(year);
    if (!y) {
      y = {
        year,
        count: 0,
        months: Array.from({ length: 12 }, (_, i) => ({
          key: monthKey(year, i),
          year,
          month: i,
          count: 0,
          firstIndex: -1,
          days: [],
        })),
      };
      years.set(year, y);
    }
    y.count += d.count;
    const m = y.months[month];
    m.count += d.count;
    m.firstIndex = m.firstIndex < 0 ? d.first_index : Math.min(m.firstIndex, d.first_index);
    m.days.push(d);
  }
  for (const y of years.values()) {
    for (const m of y.months) m.days.sort((a, b) => a.first_index - b.first_index);
  }

  const runStarts: number[] = [];
  const runDays: (TimelineDay | null)[] = [];
  for (const [start, day] of input.runs ?? []) {
    runStarts.push(start);
    runDays.push(byDay.get(day) ?? null);
  }
  // Longest stretch per key (month / year) in list order. Interruptions of
  // at most STRAY_ROWS rows between two stretches of the same key (a stray
  // imported row, an undated one) are absorbed first, so they neither split a
  // stretch nor count as a stretch of their own.
  const anchors = <K,>(keyOf: (day: string) => K) => {
    type Seg = { key: K | null; start: number; end: number };
    let segs: Seg[] = [];
    runStarts.forEach((start, k) => {
      const end = k + 1 < runStarts.length ? runStarts[k + 1] : input.total;
      const day = runDays[k]?.day;
      const key = day ? keyOf(day) : null;
      const last = segs[segs.length - 1];
      if (last && last.key === key) last.end = end;
      else segs.push({ key, start, end });
    });
    for (let changed = true; changed; ) {
      changed = false;
      const out: Seg[] = [];
      for (let k = 0; k < segs.length; k++) {
        const seg = segs[k];
        const prev = out[out.length - 1];
        const next = segs[k + 1];
        if (
          prev &&
          next &&
          prev.key !== null &&
          prev.key === next.key &&
          seg.end - seg.start <= STRAY_ROWS
        ) {
          prev.end = next.end;
          k += 1;
          changed = true;
        } else if (prev && prev.key === seg.key) {
          prev.end = seg.end;
        } else {
          out.push({ ...seg });
        }
      }
      segs = out;
    }
    const best = new Map<K, Seg>();
    for (const seg of segs) {
      if (seg.key === null) continue;
      const prev = best.get(seg.key);
      if (!prev || seg.end - seg.start > prev.end - prev.start) best.set(seg.key, seg);
    }
    return new Map([...best].map(([k, v]) => [k, v.start]));
  };
  const monthAnchor = anchors((day) => day.slice(0, 7));
  const yearAnchor = anchors((day) => Number(day.slice(0, 4)));

  return {
    days: valid,
    runStarts,
    runDays,
    monthAnchor,
    yearAnchor,
    byDate,
    byDay,
    years: [...years.values()].sort((a, b) => b.year - a.year),
    total: input.total,
  };
}

/**
 * The day of the image at `index` in the list order (null when that image has
 * no usable date). Looked up in the runs: `first_index` cannot answer this,
 * because a single stray row moves its whole day's `first_index`.
 */
export function indexToDay(timeline: Timeline | null, index: number): TimelineDay | null {
  const starts = timeline?.runStarts;
  if (starts?.length) {
    let lo = 0;
    let hi = starts.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= index) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return timeline!.runDays[best];
  }
  // No runs (empty result): nearest day by first_index.
  const days = timeline?.days;
  if (!days?.length) return null;
  let lo = 0;
  let hi = days.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid].first_index <= index) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return days[best];
}

function ticksTooClose(ticks: PhoneRulerTick[], trackHeight: number, minGap: number): boolean {
  if (trackHeight <= 0 || ticks.length < 2) return false;
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    gaps.push((ticks[i].ratio - ticks[i - 1].ratio) * trackHeight);
  }
  // A partial current month at the top should not thin every other month.
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] < minGap;
}

/**
 * Ticks for the phone's local ruler. Positions stay in track coordinates so
 * the ruler can reveal a moving window without recomputing or moving ticks.
 * Dense libraries step down from months to quarters to years only.
 */
export function phoneRulerTicks(
  timeline: Timeline | null,
  total: number,
  trackHeight: number,
): PhoneRulerTick[] {
  if (!timeline || total <= 0) return [];

  const years: PhoneRulerTick[] = [];
  for (const year of timeline.years) {
    const anchor = timeline.yearAnchor.get(year.year) ?? -1;
    if (anchor >= 0) {
      years.push({
        key: `y-${year.year}`,
        ratio: clampRatio(anchor, total),
        kind: "year",
        label: String(year.year),
      });
    }
  }
  years.sort((a, b) => a.ratio - b.ratio);

  type MonthTick = PhoneRulerTick & { monthIndex: number };
  let months: MonthTick[] = timeline.years
    .flatMap((year) => year.months)
    .filter((month) => month.count > 0)
    .map((month) => ({
      key: `m-${month.key}`,
      ratio: clampRatio(timeline.monthAnchor.get(month.key) ?? month.firstIndex, total),
      kind: "month" as const,
      monthIndex: month.month,
    }))
    .sort((a, b) => a.ratio - b.ratio);

  if (ticksTooClose(months, trackHeight, PHONE_TICK_MIN_GAP)) {
    months = months.filter((tick) => tick.monthIndex % 3 === 0);
    if (ticksTooClose(months, trackHeight, PHONE_TICK_MIN_GAP)) months = [];
  }

  // The newest year wins when two labels would overlap. Keep both ticks.
  let lastLabel = -Infinity;
  const labelledYears = years.map((tick) => {
    const y = tick.ratio * trackHeight;
    if (y - lastLabel < PHONE_YEAR_LABEL_MIN_GAP) return { ...tick, label: undefined };
    lastLabel = y;
    return tick;
  });

  return [...labelledYears, ...months].sort((a, b) => a.ratio - b.ratio);
}

function clampRatio(index: number, total: number): number {
  return Math.min(1, Math.max(0, index / total));
}

function dayDistance(a: string, b: string): number {
  return Math.abs(dateOfDay(a).getTime() - dateOfDay(b).getTime());
}

/**
 * Finds the closest day with images. `before` is used when a typed date has no
 * images (fall back to the previous day); `nearest` is used by the quick
 * buttons, which may land on either side of the requested date.
 */
export function nearestDay(
  timeline: Timeline | null,
  target: string,
  mode: "before" | "after" | "nearest" = "nearest",
): TimelineDay | null {
  const days = timeline?.byDate;
  if (!days?.length) return null;

  // Greatest day <= target, or the first later day when nothing is older.
  let lo = 0;
  let hi = days.length - 1;
  let before: TimelineDay | null = null;
  let after: TimelineDay | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const day = days[mid];
    if (day.day <= target) {
      before = day;
      lo = mid + 1;
    } else {
      after = day;
      hi = mid - 1;
    }
  }
  if (mode === "before") return before ?? after;
  if (mode === "after") return after ?? before;
  if (!before) return after;
  if (!after) return before;
  return dayDistance(before.day, target) <= dayDistance(after.day, target) ? before : after;
}

export type JumpInput =
  | { kind: "index"; index: number }
  | { kind: "month"; year: number; month: number }
  | { kind: "day"; day: string };

function validDay(year: number, month: number, day: number): boolean {
  const date = new Date(year, month - 1, day, 12);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/**
 * Supported inputs only: `#1200` / `1200`, `2026-03`, `2026-03-14`.
 * The design's "last week" placeholder is deliberately not implemented.
 */
export function parseJumpInput(raw: string, total: number): JumpInput | null {
  const text = raw.trim().replace(/[,\s]/g, "");
  if (!text) return null;

  let match = /^#?(\d+)$/.exec(text);
  if (match) {
    if (total <= 0) return null;
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n < 1) return null;
    return { kind: "index", index: Math.min(total, n) - 1 };
  }

  match = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return { kind: "month", year, month: month - 1 };
  }

  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!validDay(year, month, day)) return null;
    return { kind: "day", day: `${year}-${pad(month)}-${pad(day)}` };
  }
  return null;
}

const locale = (lang: Lang) => (lang === "zh" ? "zh-CN" : "en-US");

export function formatMonthYear(day: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    year: "numeric",
    month: lang === "zh" ? "long" : "short",
  }).format(dateOfDay(day));
}

export function formatMonthLong(year: number, month: number, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    year: "numeric",
    month: "long",
  }).format(new Date(year, month, 1, 12));
}

export function formatMonthShort(month: number, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { month: lang === "zh" ? "numeric" : "short" }).format(
    new Date(2026, month, 1, 12),
  );
}

export function formatDayLong(day: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    year: "numeric",
    month: lang === "zh" ? "long" : "short",
    day: "numeric",
  }).format(dateOfDay(day));
}

/** Monday-first weekday headings. */
export function weekdayNames(lang: Lang): string[] {
  // 2026-03-02 is a Monday.
  const monday = new Date(2026, 2, 2, 12);
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale(lang), { weekday: "short" }).format(
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, 12),
    ),
  );
}

/** Monday of the week containing `date`, at local midday. */
export function startOfWeek(date: Date): Date {
  const day = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - day, 12);
}

export function shiftMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    Math.min(date.getDate(), daysInTarget),
    12,
  );
}

