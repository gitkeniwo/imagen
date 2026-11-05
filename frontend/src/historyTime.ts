// Generation timestamps for History: compact card times and list day groups.
// Everything is shown in the viewer's local time zone.
import type { Lang } from "./i18n";

const locale = (lang: Lang) => (lang === "zh" ? "zh-CN" : "en-US");

export function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The backend sorts only canonical UTC timestamps by time
// (db.GENERATION_SORT_AT); everything else comes last. Day groups use the same
// rule, so those records end up under one "Unknown date" heading at the end.
const CANONICAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

export function sortableTime(value: string | null | undefined): Date | null {
  return value && CANONICAL_TS.test(value) ? parseTime(value) : null;
}

// Local calendar day, e.g. "2026-10-5" (only compared, never shown).
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
}

// Group heading for the list view: today / yesterday / a date (year only
// when it differs from the current one).
export function dayLabel(
  d: Date,
  now: Date,
  lang: Lang,
  t: (key: string) => string,
): string {
  const key = dayKey(d);
  if (key === dayKey(now)) return t("history_today");
  if (key === dayKey(daysBefore(now, 1))) return t("history_yesterday");
  return new Intl.DateTimeFormat(locale(lang), {
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(d);
}

export function clockTime(d: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

// Short enough for a narrow grid card: a clock time today, otherwise the date.
export function cardTime(d: Date, now: Date, lang: Lang): string {
  if (dayKey(d) === dayKey(now)) return clockTime(d, lang);
  return new Intl.DateTimeFormat(locale(lang), {
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: lang === "zh" ? "numeric" : "short",
    day: "numeric",
  }).format(d);
}

// Tooltip / accessible text with the full date and time.
export function fullTime(d: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}
