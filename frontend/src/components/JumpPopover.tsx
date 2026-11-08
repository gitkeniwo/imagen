import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { useToast } from "./Toast";
import Icon, { type IconName } from "./ui/Icon";
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
  type JumpInput,
  type Timeline,
  type TimelineDay,
  type TimelineMonth,
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
  onTypingChange?: (typing: boolean) => void;
}

interface ResultRow {
  key: string;
  icon: IconName;
  title: string;
  subtitle: string;
  run: () => void;
}

const fmtNumber = (n: number, lang: string) =>
  n.toLocaleString(lang === "zh" ? "zh-CN" : "en-US");

const pad2 = (n: number) => String(n).padStart(2, "0");

function dayLevel(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count < 5) return 1;
  if (count < 10) return 2;
  return 3;
}

/** Every month in the timeline, oldest first. Timeline years run Jan → Dec. */
function monthEntries(timeline: Timeline | null): TimelineMonth[] {
  if (!timeline) return [];
  return [...timeline.years]
    .sort((a, b) => a.year - b.year)
    .flatMap((year) => year.months);
}

/** The first calendar day of a month that actually has images. */
function firstCalendarDay(month: TimelineMonth | null): TimelineDay | null {
  if (!month?.days.length) return null;
  return [...month.days].sort((a, b) => a.day.localeCompare(b.day))[0];
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
  onTypingChange,
}: PanelProps) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const initialDay = useMemo(
    () => (timeline ? indexToDay(timeline, currentIndex) : null),
    // Only the first usable timeline seeds the selection; a later refresh must
    // not move the month the user is looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(initialDay?.day ?? null);
  const [cursorDay, setCursorDay] = useState<string | null>(initialDay?.day ?? null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [view, setView] = useState<{ year: number; month: number } | null>(
    initialDay
      ? {
          year: Number(initialDay.day.slice(0, 4)),
          month: Number(initialDay.day.slice(5, 7)) - 1,
        }
      : null,
  );
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const seeded = useRef(timeline !== null);

  // The popover mounts visibility:hidden for its first measurement, so the
  // input's autoFocus can be rejected. Focus it when its node actually exists
  // (which may be after a loading state), once the panel is visible.
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (!node || mobile) return;
      window.setTimeout(() => node.focus(), 0);
    },
    [mobile],
  );

  // Month strip state. `cellW` makes every cell exactly 1/visible of the
  // viewport, so a snap always lands on a whole month and exactly `visible`
  // whole months are on screen (no half cells, no fade).
  const stripRef = useRef<HTMLDivElement>(null);
  const stripAligned = useRef(false);
  const drag = useRef<{ x: number; left: number; moved: boolean; captured: boolean } | null>(null);
  const dragEndedAt = useRef(0);
  const stripFreeTimer = useRef<number | null>(null);
  const [cellW, setCellW] = useState(0);
  const [leftmost, setLeftmost] = useState(0);
  const [stripAtStart, setStripAtStart] = useState(true);
  const [stripAtEnd, setStripAtEnd] = useState(false);

  const visible = mobile ? 7 : 12;
  const months = useMemo(() => monthEntries(timeline), [timeline]);
  const maxMonths = Math.max(0, months.length - visible);

  useEffect(() => {
    if (!timeline || seeded.current) return;
    seeded.current = true;
    const d = indexToDay(timeline, currentIndex);
    if (d) {
      setSelectedDay(d.day);
      setCursorDay(d.day);
      setView({
        year: Number(d.day.slice(0, 4)),
        month: Number(d.day.slice(5, 7)) - 1,
      });
      return;
    }
    const y = timeline.years[0];
    const m = y?.months.find((item) => item.count > 0);
    if (y && m) setView({ year: y.year, month: m.month });
  }, [currentIndex, timeline]);

  useEffect(() => {
    onTypingChange?.(query.trim().length > 0);
  }, [onTypingChange, query]);

  const viewIndex = view
    ? months.findIndex((m) => m.year === view.year && m.month === view.month)
    : -1;
  const monthIndex = viewIndex >= 0 ? viewIndex : 0;
  const monthObj = months[monthIndex] ?? null;
  const selectedDayObj = selectedDay ? timeline?.byDay.get(selectedDay) ?? null : null;
  const cursorDayObj = cursorDay ? timeline?.byDay.get(cursorDay) ?? null : null;
  const hoverDayObj = hoverDay ? timeline?.byDay.get(hoverDay) ?? null : null;
  const statusDay = hoverDayObj ?? cursorDayObj ?? selectedDayObj;
  const fmt = (n: number) => fmtNumber(n, lang);
  const typing = query.trim().length > 0;

  // Keep the keyboard cursor on a day that exists in the month being viewed.
  useEffect(() => {
    if (!monthObj) return;
    if (cursorDay && monthObj.days.some((d) => d.day === cursorDay)) return;
    setCursorDay(firstCalendarDay(monthObj)?.day ?? null);
  }, [cursorDay, monthObj]);

  const weekdays = useMemo(() => {
    // Narrow headings (M T W …) keep seven 28px columns readable; zh uses 一 二 … .
    const formatter = new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
      weekday: "narrow",
    });
    return Array.from({ length: 7 }, (_, i) =>
      formatter.format(new Date(2026, 2, 2 + i, 12)),
    );
  }, [lang]);

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

  const showInput = (parsed: JumpInput) => {
    if (parsed.kind === "index") {
      jumpTo(parsed.index);
      return;
    }
    if (parsed.kind === "month") {
      setView({ year: parsed.year, month: parsed.month });
      const y = timeline?.years.find((item) => item.year === parsed.year);
      const m = y?.months[parsed.month];
      const first = m ? firstCalendarDay(m) : null;
      setCursorDay(first?.day ?? null);
      if (first && m) {
        setNotice(null);
        jumpTo(m.firstIndex);
        return;
      }
      setNotice(
        t("jump_month_empty", { month: formatMonthLong(parsed.year, parsed.month, lang) }),
      );
      return;
    }
    const exact = timeline?.byDay.get(parsed.day);
    if (exact) {
      setView({ year: Number(parsed.day.slice(0, 4)), month: Number(parsed.day.slice(5, 7)) - 1 });
      setCursorDay(exact.day);
      jumpTo(exact.first_index);
      return;
    }
    const previous = nearestDay(timeline, parsed.day, "before");
    if (previous) {
      setView({
        year: Number(previous.day.slice(0, 4)),
        month: Number(previous.day.slice(5, 7)) - 1,
      });
      setCursorDay(previous.day);
      const requested = formatDayLong(parsed.day, lang);
      const shown = formatDayLong(previous.day, lang);
      toast(t("jump_day_fallback", { requested, shown }), "info");
      setNotice(t("jump_day_fallback", { requested, shown }));
      jumpTo(previous.first_index);
      return;
    }
    setNotice(t("jump_day_empty"));
  };

  // Enter in the search box keeps the existing parseJumpInput contract: a
  // typed month/day that has no images explains itself instead of jumping to
  // an unrelated row.
  const submit = () => {
    if (!typing) {
      const day = cursorDayObj ?? selectedDayObj;
      if (day) jumpTo(day.first_index);
      return;
    }
    const parsed = parseJumpInput(query, total);
    if (!parsed) {
      setNotice(t("jump_invalid"));
      return;
    }
    showInput(parsed);
  };

  const results = useMemo(() => {
    const rows: ResultRow[] = [];
    const q = query.trim();
    if (!q || !timeline) return rows;
    const compact = q.replace(/[,\s]/g, "");
    const yearText = /^(\d{4})$/.exec(compact);
    if (yearText) {
      const year = timeline.years.find((y) => y.year === Number(yearText[1]));
      if (year && year.count > 0) {
        const first = year.months.reduce(
          (min, m) => (m.count > 0 ? Math.min(min, m.firstIndex) : min),
          Number.POSITIVE_INFINITY,
        );
        rows.push({
          key: `year-${year.year}`,
          icon: "arrowRight",
          title: String(year.year),
          subtitle: t("jump_result_sub", { n: fmt(year.count), index: `#${fmt(first + 1)}` }),
          run: () => jumpTo(first),
        });
      }
    }
    const parsed = parseJumpInput(q, total);
    if (!parsed) return rows;
    if (parsed.kind === "index") {
      rows.push({
        key: `index-${parsed.index}`,
        icon: "hash",
        title: `#${fmt(parsed.index + 1)}`,
        subtitle: t("jump_image_number"),
        run: () => jumpTo(parsed.index),
      });
    } else if (parsed.kind === "month") {
      const y = timeline.years.find((item) => item.year === parsed.year);
      const m = y?.months[parsed.month];
      const count = m?.count ?? 0;
      rows.push({
        key: `month-${parsed.year}-${parsed.month}`,
        icon: "arrowRight",
        title: formatMonthLong(parsed.year, parsed.month, lang),
        subtitle:
          count > 0
            ? t("jump_result_sub", { n: fmt(count), index: `#${fmt((m?.firstIndex ?? 0) + 1)}` })
            : t("jump_images_n", { n: "0" }),
        run: () => showInput(parsed),
      });
    } else {
      const exact = timeline.byDay.get(parsed.day);
      rows.push({
        key: `day-${parsed.day}`,
        icon: "calendar",
        title: formatDayLong(parsed.day, lang),
        subtitle: exact
          ? t("jump_result_sub", {
              n: fmt(exact.count),
              index: `#${fmt(exact.first_index + 1)}`,
            })
          : t("jump_day_empty"),
        run: () => showInput(parsed),
      });
    }
    return rows;
  }, [lang, onClose, onJump, query, t, timeline, total]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (highlight >= results.length) setHighlight(0);
  }, [highlight, results.length]);

  // Exactly 12 whole months on desktop, 7 on a phone. A ResizeObserver keeps
  // the cell width in sync with the popover / drawer width. While the results
  // list replaces the strip the observer is disconnected; clearing the search
  // re-measures before re-aligning the current month.
  useLayoutEffect(() => {
    if (typing) {
      stripAligned.current = false;
      setCellW(0);
      return;
    }
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setCellW(el.clientWidth / visible);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [typing, visible]);

  // Opening the panel scrolls the current month into view, centred when the
  // timeline is long enough. It runs once per mount, so picking another month
  // does not yank the strip back.
  useLayoutEffect(() => {
    if (!view || stripAligned.current || !cellW || !months.length) return;
    const off = Math.max(0, Math.min(monthIndex - Math.floor((visible - 1) / 2), maxMonths));
    stripAligned.current = true;
    const el = stripRef.current;
    if (el) el.scrollLeft = off * cellW;
    setLeftmost(off);
    setStripAtStart(off === 0);
    setStripAtEnd(off >= maxMonths);
  }, [cellW, maxMonths, monthIndex, months.length, view, visible]);

  // Wheel handling:
  //  * Sideways trackpad / shift-wheel events are left to the browser. It
  //    scrolls natively (momentum included) and CSS snaps when it comes to
  //    rest.
  //  * A mostly vertical wheel is turned into horizontal movement with snap
  //    temporarily disabled (`.free`), then snapped once after 150 ms.
  useEffect(() => {
    if (mobile) return; // phones use native touch scrolling
    const el = stripRef.current;
    if (!el || !cellW) return;
    const finish = () => {
      stripFreeTimer.current = null;
      el.classList.remove("free");
      const target = Math.max(0, Math.min(maxMonths, Math.round(el.scrollLeft / cellW)));
      el.scrollTo({ left: target * cellW, behavior: "smooth" });
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // pinch zoom, not a scroll
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return; // native
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? el.clientWidth
            : 1;
      const dx = (event.deltaX + event.deltaY) * unit;
      el.classList.add("free");
      void el.offsetWidth; // apply scroll-snap-type: none before moving
      el.scrollLeft += dx;
      if (stripFreeTimer.current !== null) window.clearTimeout(stripFreeTimer.current);
      stripFreeTimer.current = window.setTimeout(finish, 150);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (stripFreeTimer.current !== null) {
        window.clearTimeout(stripFreeTimer.current);
        stripFreeTimer.current = null;
      }
    };
  }, [cellW, maxMonths, mobile]);

  // The last scroll can land after momentum/snap; refresh the pinned year and
  // the ‹ › disabled state again when scrolling really ends.
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !cellW) return;
    let timer: number | null = null;
    const sync = () => {
      const off = Math.max(0, Math.min(maxMonths, Math.round(el.scrollLeft / cellW)));
      setLeftmost(off);
      setStripAtStart(el.scrollLeft <= 1);
      setStripAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 1);
    };
    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(sync, 140);
    };
    const supportsScrollEnd =
      typeof (el as unknown as Record<string, unknown>).onscrollend !== "undefined";
    if (supportsScrollEnd) el.addEventListener("scrollend", sync);
    else el.addEventListener("scroll", onScroll);
    return () => {
      if (supportsScrollEnd) el.removeEventListener("scrollend", sync);
      else el.removeEventListener("scroll", onScroll);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [cellW, maxMonths]);

  const onStripScroll = () => {
    const el = stripRef.current;
    if (!el || !cellW) return;
    const off = Math.max(0, Math.min(maxMonths, Math.round(el.scrollLeft / cellW)));
    setLeftmost(off);
    setStripAtStart(el.scrollLeft <= 1);
    setStripAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 1);
  };

  const scrollToMonthIndex = (index: number, smooth: boolean) => {
    const el = stripRef.current;
    if (!el || !cellW) return;
    const off = Math.max(0, Math.min(maxMonths, index));
    el.scrollTo({ left: off * cellW, behavior: smooth ? "smooth" : "auto" });
  };

  const moveYear = (direction: -1 | 1) => {
    const el = stripRef.current;
    if (!el || !cellW) return;
    const current = Math.max(0, Math.min(maxMonths, Math.round(el.scrollLeft / cellW)));
    scrollToMonthIndex(current + direction * visible, true);
  };

  const selectMonth = (m: TimelineMonth) => {
    if (m.count <= 0) return;
    setView({ year: m.year, month: m.month });
    setCursorDay(firstCalendarDay(m)?.day ?? null);
    setNotice(null);
  };

  const moveCursor = (days: number) => {
    if (!monthObj || !cursorDay) return;
    const start = dateOfDay(cursorDay);
    let next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days, 12);
    for (let guard = 0; guard < 45; guard++) {
      if (next.getMonth() !== monthObj.month) return;
      if (timeline?.byDay.has(dayKeyOf(next))) {
        setCursorDay(dayKeyOf(next));
        return;
      }
      next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + Math.sign(days || 1), 12);
    }
  };

  const onCalendarKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveCursor(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      moveCursor(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveCursor(-7);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveCursor(7);
    } else if (event.key === "Home" && monthObj) {
      event.preventDefault();
      setCursorDay(firstCalendarDay(monthObj)?.day ?? null);
    } else if (event.key === "End" && monthObj) {
      event.preventDefault();
      const last = [...monthObj.days].sort((a, b) => b.day.localeCompare(a.day))[0];
      setCursorDay(last?.day ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (cursorDayObj) jumpTo(cursorDayObj.first_index);
    }
  };

  const onStripKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || !cellW) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const current = Math.round(el.scrollLeft / cellW);
      scrollToMonthIndex(current + (event.key === "ArrowRight" ? 1 : -1), true);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      moveYear(event.key === "PageDown" ? 1 : -1);
    }
  };

  const calendar = useMemo(() => {
    if (!monthObj) return { cells: [] as (string | null)[] };
    const first = new Date(monthObj.year, monthObj.month, 1, 12);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(monthObj.year, monthObj.month + 1, 0, 12).getDate();
    const length = Math.ceil((offset + daysInMonth) / 7) * 7;
    const cells = Array.from({ length }, (_, i) => {
      const day = i - offset + 1;
      if (day < 1 || day > daysInMonth) return null;
      return `${monthObj.year}-${pad2(monthObj.month + 1)}-${pad2(day)}`;
    });
    return { cells };
  }, [monthObj]);

  const barMax = useMemo(
    () => Math.max(1, ...months.map((m) => m.count)),
    [months],
  );
  const leftmostMonth = months[leftmost];
  const monthHeading = monthObj ? formatMonthLong(monthObj.year, monthObj.month, lang) : "";

  const daySummary = (day: TimelineDay) => {
    const date = formatDayLong(day.day, lang);
    const text = t("jump_day_summary", {
      date,
      n: fmt(day.count),
      index: `#${fmt(day.first_index + 1)}`,
    });
    const at = text.indexOf(date);
    if (at < 0) return <>{text}</>;
    return (
      <>
        <b>{date}</b>
        {text.slice(at + date.length)}
      </>
    );
  };

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

  const searchRow = mobile ? (
    <div className="jump-search-row">
      <label className="jump-search-box">
        <Icon name="search" size="md" />
        <input
          value={query}
          placeholder={t("jump_placeholder_mobile")}
          aria-label={t("jump_to")}
          inputMode="text"
          enterKeyHint="go"
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
            setNotice(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (results.length > 0) results[Math.min(highlight, results.length - 1)].run();
              else submit();
            } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length > 0) {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setHighlight((h) => (h + step + results.length) % results.length);
            }
          }}
        />
        {typing && (
          <button
            type="button"
            className="jump-search-clear"
            aria-label={t("jump_clear")}
            onClick={() => {
              setQuery("");
              setNotice(null);
              setHighlight(0);
            }}
          >
            <Icon name="close" size="sm" />
          </button>
        )}
      </label>
      <button type="button" className="jump-cancel" onClick={onClose}>
        {t("cancel")}
      </button>
    </div>
  ) : (
    <div className="jump-search">
      <Icon name="search" size="md" />
      <input
        ref={setInputRef}
        autoFocus
        value={query}
        placeholder={t("jump_placeholder")}
        aria-label={t("jump_to")}
        inputMode="text"
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setNotice(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (results.length > 0) results[Math.min(highlight, results.length - 1)].run();
            else submit();
          } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length > 0) {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setHighlight((h) => (h + step + results.length) % results.length);
          }
        }}
      />
      <kbd className="jump-kbd">Esc</kbd>
    </div>
  );

  const quickRow = (
    <div
      className={`jump-quick${mobile ? " jump-quick-mobile" : ""}`}
      role="group"
      aria-label={t("jump_to")}
    >
      {quick.map((item) => (
        <button
          key={item.key}
          type="button"
          className="jump-quick-btn"
          disabled={item.index === null}
          onClick={() => jumpTo(item.index)}
        >
          {item.label}
          {item.count > 0 && <span className="jump-quick-count">{fmt(item.count)}</span>}
        </button>
      ))}
    </div>
  );

  const strip = (
    <div className="jump-strip-wrap">
      {leftmostMonth && leftmostMonth.month !== 0 && (
        <span className="jump-strip-year-pin" aria-hidden="true">
          {leftmostMonth.year}
        </span>
      )}
      <div
        ref={stripRef}
        className="jump-strip"
        role="listbox"
        aria-label={t("jump_month")}
        tabIndex={0}
        onScroll={onStripScroll}
        onKeyDown={onStripKey}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse" || event.button !== 0) return;
          const el = stripRef.current;
          if (!el) return;
          // Capture only once a real drag starts; capturing on pointerdown
          // would retarget the click and month cells would never activate.
          drag.current = {
            x: event.clientX,
            left: el.scrollLeft,
            moved: false,
            captured: false,
          };
          dragEndedAt.current = 0;
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          const el = stripRef.current;
          if (!current || !el) return;
          const dx = event.clientX - current.x;
          if (Math.abs(dx) > 3) current.moved = true;
          if (!current.moved) return;
          if (!current.captured) {
            el.setPointerCapture(event.pointerId);
            current.captured = true;
          }
          if (stripFreeTimer.current !== null) {
            window.clearTimeout(stripFreeTimer.current);
            stripFreeTimer.current = null;
          }
          if (!el.classList.contains("free")) {
            el.classList.add("free");
            void el.offsetWidth;
          }
          el.scrollLeft = current.left - dx;
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          const el = stripRef.current;
          drag.current = null;
          if (!current || !el) return;
          if (current.captured) el.releasePointerCapture(event.pointerId);
          if (!current.moved) return;
          dragEndedAt.current = Date.now();
          el.classList.remove("free");
          const off = Math.max(0, Math.min(maxMonths, Math.round(el.scrollLeft / cellW)));
          el.scrollTo({ left: off * cellW, behavior: "smooth" });
        }}
        onPointerCancel={() => {
          const el = stripRef.current;
          drag.current = null;
          if (el) {
            el.classList.remove("free");
            const off = Math.max(0, Math.min(maxMonths, Math.round(el.scrollLeft / cellW)));
            el.scrollTo({ left: off * cellW, behavior: "smooth" });
          }
        }}
      >
        <div className="jump-strip-track">
          {months.map((m) => {
            const selected = m.year === view?.year && m.month === view.month;
            const height = m.count > 0 ? 3 + Math.round((m.count / barMax) * 13) : 3;
            return (
              <button
                key={m.key}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`${formatMonthLong(m.year, m.month, lang)} · ${fmt(m.count)}`}
                tabIndex={-1}
                disabled={m.count <= 0}
                className={[
                  "jump-strip-month",
                  selected ? "on" : "",
                  m.count <= 0 ? "empty" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ width: cellW || undefined }}
                onClick={() => {
                  if (Date.now() - dragEndedAt.current < 200) return;
                  selectMonth(m);
                }}
              >
                {m.month === 0 && (
                  <span className="jump-strip-year" aria-hidden="true">
                    {m.year}
                  </span>
                )}
                <span className="jump-strip-bar" style={{ height }} />
                <span className="jump-strip-name">{formatMonthShort(m.month, lang)}</span>
              </button>
            );
          })}
        </div>
      </div>
      {!mobile && (
        <span className="jump-strip-arrows">
          <button
            type="button"
            className="jump-strip-arrow"
            aria-label={t("jump_prev_year")}
            title={t("jump_prev_year")}
            tabIndex={-1}
            disabled={stripAtStart}
            onClick={() => moveYear(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="jump-strip-arrow"
            aria-label={t("jump_next_year")}
            title={t("jump_next_year")}
            tabIndex={-1}
            disabled={stripAtEnd}
            onClick={() => moveYear(1)}
          >
            ›
          </button>
        </span>
      )}
    </div>
  );

  const calendarView = (
    <div className="jump-calendar">
      <div className="jump-calendar-head">
        <b>{monthHeading}</b>
        <span>{t("jump_images_n", { n: fmt(monthObj?.count ?? 0) })}</span>
      </div>
      <div className="jump-weekdays" aria-hidden="true">
        {weekdays.map((name, i) => (
          <span key={i}>{name}</span>
        ))}
      </div>
      <div
        className="jump-days"
        role="grid"
        aria-label={monthHeading}
        aria-activedescendant={cursorDay ? `jump-day-${cursorDay}` : undefined}
        tabIndex={0}
        onKeyDown={onCalendarKey}
        onFocus={() => {
          if (!cursorDay && monthObj) setCursorDay(firstCalendarDay(monthObj)?.day ?? null);
        }}
      >
        {calendar.cells.map((day, i) => {
          if (!day) return <span key={i} className="jump-day blank" aria-hidden="true" />;
          const d = timeline.byDay.get(day);
          const count = d?.count ?? 0;
          const level = dayLevel(count);
          return (
            <button
              key={day}
              id={`jump-day-${day}`}
              type="button"
              role="gridcell"
              tabIndex={-1}
              className={[
                "jump-day",
                `l${level}`,
                selectedDay === day ? "on" : "",
                cursorDay === day ? "cursor" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              disabled={!d}
              aria-current={selectedDay === day ? "date" : undefined}
              aria-label={`${formatDayLong(day, lang)} · ${t("jump_day_count", { n: fmt(count) })}`}
              title={t("jump_day_count", { n: fmt(count) })}
              onClick={() => d && jumpTo(d.first_index)}
              onMouseEnter={() => setHoverDay(day)}
              onMouseLeave={() => setHoverDay((current) => (current === day ? null : current))}
            >
              {dateOfDay(day).getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );

  const resultsView = (
    <div className="jump-results" role="listbox" aria-label={t("jump_results")}>
      {mobile && <div className="jump-results-head">{t("jump_results")}</div>}
      {results.length > 0 ? (
        results.map((row, i) => (
          <button
            key={row.key}
            type="button"
            role="option"
            aria-selected={i === highlight}
            tabIndex={-1}
            className={`jump-result${i === highlight ? " on" : ""}`}
            onMouseEnter={() => setHighlight(i)}
            onClick={row.run}
          >
            <span className="jump-result-icon">
              <Icon name={row.icon} size="sm" />
            </span>
            <span className="jump-result-text">
              <b>{row.title}</b>
              <span>{row.subtitle}</span>
            </span>
          </button>
        ))
      ) : (
        <p className="jump-results-empty">{t("jump_invalid")}</p>
      )}
    </div>
  );

  return (
    <div className={`jump-panel ${mobile ? "jump-mobile" : "jump-desktop"}`}>
      {searchRow}
      {mobile ? (
        <div className="jump-mobile-body">
          {typing ? (
            resultsView
          ) : (
            <>
              {quickRow}
              {strip}
              {calendarView}
              <div className="jump-mobile-foot">
                <span>{t("jump_tap_day")}</span>
                {statusDay && <span>{daySummary(statusDay)}</span>}
              </div>
            </>
          )}
          {notice && <p className="jump-notice">{notice}</p>}
        </div>
      ) : (
        <div className="jump-desktop-body">
          {quickRow}
          {notice && <p className="jump-notice">{notice}</p>}
          {typing ? (
            resultsView
          ) : (
            <>
              {strip}
              {calendarView}
            </>
          )}
          <div className="jump-status">
            <span className="jump-status-summary">{statusDay ? daySummary(statusDay) : null}</span>
            <span className="jump-status-keys">
              <span>
                <kbd>← →</kbd> {t("jump_key_day")}
              </span>
              <span>
                <kbd>↑ ↓</kbd> {t("jump_key_week")}
              </span>
              <span>
                <kbd>↵</kbd> {t("jump_key_jump")}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The jump dialog: one `JumpPanel` with two shells. Desktop anchors a Popover
 * under the position line; phone opens a content-height Sheet with a search
 * row and Cancel. In both, a day jumps immediately and closes.
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
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (!open) setTyping(false);
  }, [open]);

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
      onTypingChange={setTyping}
    />
  );

  if (phone) {
    return (
      <>
        {trigger}
        {open && (
          <Sheet
            className={`jump-sheet${typing ? " jump-sheet-typing" : ""}`}
            title={t("jump_to")}
            hideHead
            grabDraggable
            focusPanel
            onClose={onClose}
          >
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
