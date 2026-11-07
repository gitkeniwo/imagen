import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useToast } from "./Toast";
import Icon from "./ui/Icon";
import Popover from "./ui/Popover";
import Sheet from "./ui/Sheet";
import {
  dateOfDay,
  dayKeyOf,
  formatDayLong,
  formatMonthLong,
  formatMonthShort,
  indexToDay,
  nearestDay,
  parseJumpInput,
  shiftMonths,
  startOfWeek,
  type Timeline,
  type TimelineDay,
  type TimelineMonth,
  weekdayNames,
} from "../timeline";

interface JumpProps {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  phone: boolean;
  timeline: Timeline | null;
  loading: boolean;
  error: string | null;
  total: number;
  currentIndex: number;
  onJump: (index: number) => void;
}

interface PanelProps {
  mobile: boolean;
  timeline: Timeline | null;
  loading: boolean;
  error: string | null;
  total: number;
  currentIndex: number;
  onJump: (index: number) => void;
  onClose: () => void;
}

const fmtNumber = (n: number, lang: string) =>
  n.toLocaleString(lang === "zh" ? "zh-CN" : "en-US");

function firstDayOfMonth(month: TimelineMonth): TimelineDay | null {
  return month.days[0] ?? null;
}

function dayLevel(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count < 5) return 1;
  if (count < 10) return 2;
  return 3;
}

function JumpPanel({
  mobile,
  timeline,
  loading,
  error,
  total,
  currentIndex,
  onJump,
  onClose,
}: PanelProps) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const initialDay = useMemo(
    () => (timeline ? indexToDay(timeline, currentIndex) : null),
    // Only the first usable timeline needs to seed the selection; a later
    // refresh must not move the month the user is looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(initialDay?.day ?? null);
  const [selectedYear, setSelectedYear] = useState<number | null>(
    initialDay ? Number(initialDay.day.slice(0, 4)) : timeline?.years[0]?.year ?? null,
  );
  const [selectedMonth, setSelectedMonth] = useState<number | null>(
    initialDay
      ? Number(initialDay.day.slice(5, 7)) - 1
      : timeline?.years[0]?.months.find((m) => m.count > 0)?.month ?? null,
  );
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const seeded = useRef(timeline !== null);

  useEffect(() => {
    if (!timeline || seeded.current) return;
    seeded.current = true;
    const d = indexToDay(timeline, currentIndex);
    if (d) {
      setSelectedDay(d.day);
      setSelectedYear(Number(d.day.slice(0, 4)));
      setSelectedMonth(Number(d.day.slice(5, 7)) - 1);
      return;
    }
    const y = timeline.years[0];
    if (y) {
      setSelectedYear(y.year);
      setSelectedMonth(y.months.find((m) => m.count > 0)?.month ?? null);
    }
  }, [currentIndex, timeline]);

  const yearObj = useMemo(
    () => timeline?.years.find((y) => y.year === selectedYear) ?? timeline?.years[0] ?? null,
    [selectedYear, timeline],
  );
  const monthObj =
    yearObj && selectedMonth !== null ? yearObj.months[selectedMonth] ?? null : null;
  const selectedDayObj = selectedDay ? timeline?.byDay.get(selectedDay) ?? null : null;
  const fmt = (n: number) => fmtNumber(n, lang);

  const weekdays = useMemo(() => weekdayNames(lang), [lang]);

  const quick = useMemo(() => {
    const none = { index: null as number | null, count: 0 };
    if (!timeline || timeline.days.length === 0) {
      return [
        { key: "newest", label: t("jump_newest"), ...none },
        { key: "today", label: t("jump_today"), ...none },
        { key: "week", label: t("jump_this_week"), ...none },
        { key: "month", label: t("jump_month_ago"), ...none },
        { key: "year", label: t("jump_year_ago"), ...none },
        { key: "oldest", label: t("jump_oldest"), ...none },
      ];
    }
    const now = new Date();
    const today = dayKeyOf(now);
    const todayDay = nearestDay(timeline, today, "nearest");
    const weekStart = dayKeyOf(startOfWeek(now));
    const thisWeek = timeline.byDate.filter((d) => d.day >= weekStart && d.day <= today);
    const weekDay = thisWeek[0] ?? nearestDay(timeline, weekStart, "nearest");
    const monthAgo = nearestDay(timeline, dayKeyOf(shiftMonths(now, -1)), "nearest");
    const yearAgo = nearestDay(timeline, dayKeyOf(shiftMonths(now, -12)), "nearest");
    return [
      { key: "newest", label: t("jump_newest"), index: 0, count: 0 },
      {
        key: "today",
        label: t("jump_today"),
        index: todayDay?.first_index ?? null,
        count: timeline.byDay.get(today)?.count ?? 0,
      },
      {
        key: "week",
        label: t("jump_this_week"),
        index: weekDay?.first_index ?? null,
        count: thisWeek.reduce((sum, d) => sum + d.count, 0),
      },
      {
        key: "month",
        label: t("jump_month_ago"),
        index: monthAgo?.first_index ?? null,
        count: 0,
      },
      {
        key: "year",
        label: t("jump_year_ago"),
        index: yearAgo?.first_index ?? null,
        count: 0,
      },
      { key: "oldest", label: t("jump_oldest"), index: Math.max(0, total - 1), count: 0 },
    ];
  }, [t, timeline, total]);

  const jumpTo = (index: number | null) => {
    if (index === null || index < 0 || index >= total) return;
    onJump(index);
    onClose();
  };

  const selectDay = (d: TimelineDay) => {
    setSelectedDay(d.day);
    setSelectedYear(Number(d.day.slice(0, 4)));
    setSelectedMonth(Number(d.day.slice(5, 7)) - 1);
    setNotice(null);
  };

  const selectMonth = (m: TimelineMonth) => {
    setSelectedYear(m.year);
    setSelectedMonth(m.month);
    const first = firstDayOfMonth(m);
    setSelectedDay(first?.day ?? null);
    setNotice(
      first ? null : t("jump_month_empty", { month: formatMonthLong(m.year, m.month, lang) }),
    );
  };

  const selectYear = (year: number) => {
    const y = timeline?.years.find((item) => item.year === year);
    setSelectedYear(year);
    const sameMonth = y?.months.find((m) => m.month === selectedMonth && m.count > 0);
    const month = sameMonth ?? y?.months.find((m) => m.count > 0);
    if (!month) {
      setSelectedMonth(selectedMonth);
      setSelectedDay(null);
      return;
    }
    setSelectedMonth(month.month);
    setSelectedDay(firstDayOfMonth(month)?.day ?? null);
    setNotice(null);
  };

  // Enter and Go share this resolver. `jump` is false while the user is only
  // typing; Enter/Go pass true and either move or leave the panel open on an
  // empty month with an explanation.
  const submit = (jump: boolean) => {
    const hasQuery = query.trim().length > 0;
    const parsed = parseJumpInput(query, total);
    if (hasQuery && !parsed) {
      setNotice(t("jump_invalid"));
      return;
    }
    if (!parsed) {
      if (selectedDayObj) {
        if (jump) jumpTo(selectedDayObj.first_index);
      } else {
        setNotice(t("jump_pick_day"));
      }
      return;
    }
    if (parsed.kind === "index") {
      if (jump) jumpTo(parsed.index);
      return;
    }
    if (parsed.kind === "month") {
      const y = timeline?.years.find((item) => item.year === parsed.year);
      const m = y?.months[parsed.month];
      setSelectedYear(parsed.year);
      setSelectedMonth(parsed.month);
      const first = m ? firstDayOfMonth(m) : null;
      if (!first) {
        setSelectedDay(null);
        setNotice(
          t("jump_month_empty", { month: formatMonthLong(parsed.year, parsed.month, lang) }),
        );
        return;
      }
      setSelectedDay(first.day);
      setNotice(null);
      if (jump) jumpTo(first.first_index);
      return;
    }

    const exact = timeline?.byDay.get(parsed.day);
    if (exact) {
      selectDay(exact);
      if (jump) jumpTo(exact.first_index);
      return;
    }
    const previous = nearestDay(timeline, parsed.day, "before");
    if (previous) {
      selectDay(previous);
      const requested = formatDayLong(parsed.day, lang);
      const shown = formatDayLong(previous.day, lang);
      setNotice(t("jump_day_fallback", { requested, shown }));
      if (jump) {
        toast(t("jump_day_fallback", { requested, shown }), "info");
        jumpTo(previous.first_index);
      }
      return;
    }
    setSelectedDay(parsed.day);
    setNotice(t("jump_day_empty"));
  };

  const calendar = useMemo(() => {
    if (!yearObj || selectedMonth === null) return { offset: 0, daysInMonth: 0, cells: [] as (string | null)[] };
    const first = new Date(yearObj.year, selectedMonth, 1, 12);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(yearObj.year, selectedMonth + 1, 0, 12).getDate();
    const cells = Array.from({ length: 42 }, (_, i) => {
      const day = i - offset + 1;
      if (day < 1 || day > daysInMonth) return null;
      return `${yearObj.year}-${String(selectedMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    });
    return { offset, daysInMonth, cells };
  }, [selectedMonth, yearObj]);

  const monthMax = yearObj ? Math.max(1, ...yearObj.months.map((m) => m.count)) : 1;
  const goEnabled = query.trim()
    ? parseJumpInput(query, total) !== null
    : selectedDayObj !== null;

  const years = (
    <div className={`jump-years${mobile ? " jump-years-seg" : ""}`} role="group" aria-label={t("jump_year")}>
      {!mobile && <span className="jump-years-label">{t("jump_year")}</span>}
      {timeline?.years.map((y) => (
        <button
          key={y.year}
          type="button"
          className={`jump-year${yearObj?.year === y.year ? " on" : ""}`}
          aria-pressed={yearObj?.year === y.year}
          onClick={() => selectYear(y.year)}
        >
          <span>{y.year}</span>
          <span className="jump-year-count">{fmt(y.count)}</span>
        </button>
      ))}
    </div>
  );

  const months = (
    <div className={`jump-months${mobile ? " jump-months-mobile" : ""}`} role="group" aria-label={t("jump_month")}>
      {(yearObj?.months ?? Array.from({ length: 12 })).map((item, i) => {
        const m = item as TimelineMonth | undefined;
        const count = m?.count ?? 0;
        const selected = selectedMonth === i;
        return (
          <button
            key={m?.key ?? i}
            type="button"
            className={`jump-month${selected ? " on" : ""}`}
            aria-pressed={selected}
            disabled={!m || count === 0}
            onClick={() => m && selectMonth(m)}
          >
            <span className="jump-month-name-row">
              <span className="jump-month-name">{formatMonthShort(i, lang)}</span>
              <span className="jump-month-count">{count > 0 ? fmt(count) : "—"}</span>
            </span>
            <span className="jump-month-bar">
              <span style={{ width: `${count > 0 ? Math.max(4, (count / monthMax) * 100) : 0}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );

  const calendarView = (
    <div className="jump-calendar">
      <div className="jump-calendar-head">
        <span>
          {yearObj && selectedMonth !== null
            ? formatMonthLong(yearObj.year, selectedMonth, lang)
            : ""}
          <span> · {t("jump_images_n", { n: fmt(monthObj?.count ?? 0) })}</span>
        </span>
        {!mobile && <em>{t("jump_darker")}</em>}
      </div>
      <div className="jump-weekdays" aria-hidden="true">
        {weekdays.map((name, i) => (
          <span key={i}>{name}</span>
        ))}
      </div>
      <div className="jump-days">
        {calendar.cells.map((day, i) => {
          if (!day) return <span key={i} className="jump-day blank" aria-hidden="true" />;
          const d = timeline?.byDay.get(day);
          const count = d?.count ?? 0;
          const level = dayLevel(count);
          return (
            <button
              key={day}
              type="button"
              className={`jump-day l${level}${selectedDay === day ? " on" : ""}`}
              disabled={!d}
              aria-pressed={selectedDay === day}
              title={t("jump_day_count", { n: fmt(count) })}
              onClick={() => d && selectDay(d)}
              onDoubleClick={() => d && !mobile && jumpTo(d.first_index)}
            >
              {dateOfDay(day).getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (loading && !timeline) {
    return (
      <div className={`jump-panel ${mobile ? "jump-mobile" : "jump-desktop"}`}>
        <p className="jump-loading small muted">
          <span className="spinner" /> {t("loading")}
        </p>
      </div>
    );
  }
  if (error && !timeline) {
    return (
      <div className={`jump-panel ${mobile ? "jump-mobile" : "jump-desktop"}`}>
        <p className="jump-loading small muted">{t("load_error", { msg: error })}</p>
      </div>
    );
  }
  if (!timeline || timeline.days.length === 0) {
    return (
      <div className={`jump-panel ${mobile ? "jump-mobile" : "jump-desktop"}`}>
        <p className="jump-loading small muted">{t("jump_no_dates")}</p>
      </div>
    );
  }

  return (
    <div className={`jump-panel ${mobile ? "jump-mobile" : "jump-desktop"}`}>
      <div className="jump-main">
        <div className="jump-input">
          <label className="jump-input-box">
            <Icon name="search" size="sm" />
            <input
              autoFocus={!mobile}
              value={query}
              placeholder={t("jump_placeholder")}
              aria-label={t("jump_to")}
              inputMode="text"
              onChange={(e) => {
                setQuery(e.target.value);
                setNotice(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit(true);
                }
              }}
            />
          </label>
          <div className="jump-quick">
            {quick.map((item) => (
              <button
                key={item.key}
                type="button"
                className="jump-chip"
                disabled={item.index === null}
                onClick={() => jumpTo(item.index)}
              >
                {item.label}
                {item.count > 0 && <span className="jump-chip-count"> · {fmt(item.count)}</span>}
              </button>
            ))}
          </div>
          {notice && <p className="jump-notice">{notice}</p>}
        </div>

        {mobile ? (
          <div className="jump-picker">
            {years}
            {months}
            {calendarView}
          </div>
        ) : (
          <div className="jump-picker">
            {years}
            <div className="jump-right">
              {months}
              {calendarView}
            </div>
          </div>
        )}
      </div>

      <div className="jump-foot">
        <span className="jump-summary">
          {selectedDayObj
            ? t("jump_day_summary", {
                date: formatDayLong(selectedDayObj.day, lang),
                n: fmt(selectedDayObj.count),
                index: `#${fmt(selectedDayObj.first_index + 1)}`,
              })
            : t("jump_pick_day")}
        </span>
        <button type="button" className="jump-go" disabled={!goEnabled} onClick={() => submit(true)}>
          {t("jump_go")}
        </button>
      </div>
    </div>
  );
}

/**
 * The jump dialog: one `JumpPanel` with two shells. Desktop anchors a Popover
 * under the position bar; phone opens the existing Sheet, whose footer is kept
 * above the safe area by the panel's own foot row.
 */
export default function JumpPopover({
  open,
  onClose,
  trigger,
  phone,
  timeline,
  loading,
  error,
  total,
  currentIndex,
  onJump,
}: JumpProps) {
  const { t } = useI18n();
  const panel = (
    <JumpPanel
      mobile={phone}
      timeline={timeline}
      loading={loading}
      error={error}
      total={total}
      currentIndex={currentIndex}
      onJump={onJump}
      onClose={onClose}
    />
  );

  if (phone) {
    return (
      <>
        {trigger}
        {open && (
          <Sheet className="jump-sheet" title={t("jump_to")} onClose={onClose}>
            {panel}
          </Sheet>
        )}
      </>
    );
  }

  return (
    <Popover
      fixed
      fitViewport
      align="start"
      open={open}
      onClose={onClose}
      trigger={trigger}
      panelClassName="jump-popover"
      panelProps={{ role: "dialog", "aria-label": t("jump_to") }}
    >
      {panel}
    </Popover>
  );
}

