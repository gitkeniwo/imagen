import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import {
  formatMonthShort,
  formatMonthYear,
  indexToDay,
  type Timeline,
  type TimelineDay,
} from "../timeline";
import Icon from "./ui/Icon";

export type ScrubberMode = "compact" | "full" | "phone";

interface Props {
  mode: ScrubberMode;
  total: number;
  // First tile of the first visible row.
  index: number;
  // Number of tiles on one screen, for PageUp / PageDown.
  step: number;
  timeline: Timeline | null;
  scrollerRef: RefObject<HTMLElement | null>;
  headerRef: RefObject<HTMLElement | null>;
  onSeek: (index: number) => void;
  onLongPress?: () => void;
}

const LONG_PRESS_MS = 450;
const BUBBLE_HOLD_MS = 700;
const PHONE_FADE_MS = 1500;

interface Mark {
  key: string;
  ratio: number;
  label?: string;
  year: boolean;
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

/**
 * Timeline scrubber pinned to the right edge of the Library's scroll area.
 *
 * It is portaled and positioned against the scroller's rect, because the
 * Library scrolls inside the sidebar / fullscreen manager / phone island and
 * an absolutely positioned track would scroll away with the content. The
 * thumb is a real `role="scrollbar"`: pointer capture for dragging, arrows for
 * one row, PageUp / PageDown for a screen, Home / End for the ends.
 */
export default function LibraryScrubber({
  mode,
  total,
  index,
  step,
  timeline,
  scrollerRef,
  headerRef,
  onSeek,
  onLongPress,
}: Props) {
  const { t, lang } = useI18n();
  const hitRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<{ top: number; right: number; bottom: number } | null>(null);
  // Portal into the scroller itself, not <body>: the fullscreen manager and
  // the picker are fixed overlays with their own stacking context, and a
  // body-level overlay would sit behind them.
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [bubble, setBubble] = useState(false);
  const [faded, setFaded] = useState(false);
  const [height, setHeight] = useState(0);
  const holdTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const fadeTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const start = useRef<{ y: number } | null>(null);

  const clearTimers = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    holdTimer.current = null;
    hideTimer.current = null;
    fadeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // The overlay is fixed: measure the scroller and the sticky header so the
  // track starts below the header and ends at the scroller's bottom edge.
  useLayoutEffect(() => {
    const measure = () => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        setFrame(null);
        return;
      }
      // Prefer the scroller's parent: iOS Safari treats an element with
      // `-webkit-overflow-scrolling: touch` as a containing block, which would
      // make the fixed overlay scroll with the grid.
      const nextHost = scroller.parentElement ?? scroller;
      setHost((prev) => (prev === nextHost ? prev : nextHost));
      const rect = scroller.getBoundingClientRect();
      const head = headerRef.current?.getBoundingClientRect();
      const top = Math.max(rect.top + 6, (head?.bottom ?? rect.top) + 6);
      const bottom = Math.max(0, window.innerHeight - rect.bottom + 6);
      const right = Math.max(0, window.innerWidth - rect.right + (mode === "full" ? 8 : 4));
      setHeight(Math.max(0, window.innerHeight - top - bottom));
      setFrame((prev) =>
        prev && Math.abs(prev.top - top) < 0.5 && Math.abs(prev.bottom - bottom) < 0.5 && Math.abs(prev.right - right) < 0.5
          ? prev
          : { top, right, bottom },
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    if (scrollerRef.current) ro.observe(scrollerRef.current);
    if (headerRef.current) ro.observe(headerRef.current);
    window.addEventListener("resize", measure);
    const scroller = scrollerRef.current;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      scroller?.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [headerRef, mode, scrollerRef]);

  const ratio = total > 1 ? clamp01(index / (total - 1)) : 0;
  const shownIndex = active ?? index;
  const shownRatio = total > 1 ? clamp01(shownIndex / (total - 1)) : 0;

  const bubbleText = useMemo(() => {
    const day: TimelineDay | null = timeline ? indexToDay(timeline, shownIndex) : null;
    const month = day ? formatMonthYear(day.day, lang) : "";
    const number = `#${(shownIndex + 1).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}`;
    if (mode === "phone") return month || number;
    return month ? `${month} · ${number}` : number;
  }, [lang, mode, shownIndex, timeline]);

  const marks = useMemo<Mark[]>(() => {
    if (!timeline || mode === "phone" || total <= 0) return [];
    const years: Mark[] = [];
    for (const y of timeline.years) {
      let first = -1;
      for (const m of y.months) {
        if (m.count > 0 && (first < 0 || m.firstIndex < first)) first = m.firstIndex;
      }
      if (first >= 0) {
        years.push({
          key: `y-${y.year}`,
          ratio: clamp01(first / total),
          label: mode === "compact" ? undefined : String(y.year),
          year: true,
        });
      }
    }

    if (mode === "compact") {
      const months: Mark[] = timeline.years
        .flatMap((y) => y.months)
        .filter((m) => m.count > 0)
        .map((m) => ({
          key: `m-${m.key}`,
          ratio: clamp01(m.firstIndex / total),
          year: false,
        }));
      return [...years, ...months];
    }

    // Full screen: year labels always, month labels only when there is room.
    const months: Mark[] = timeline.years
      .flatMap((y) => y.months)
      .filter((m) => m.count > 0)
      .map((m) => ({
        key: `m-${m.key}`,
        ratio: clamp01(m.firstIndex / total),
        label: formatMonthShort(m.month, lang),
        year: false,
      }));
    const all = [...years, ...months].sort((a, b) => a.ratio - b.ratio);
    if (height <= 0) return years;
    const out: Mark[] = [];
    let lastY = -Infinity;
    for (const mark of all) {
      const y = mark.ratio * height;
      if (mark.year) {
        // A handful of imported rows can put a whole year's first_index next
        // to another year's; keep the label rows at least 10px apart.
        if (y - lastY < 10) continue;
        out.push(mark);
        lastY = y;
      } else if (y - lastY >= 14) {
        out.push(mark);
        lastY = y;
      }
    }
    return out;
  }, [height, lang, mode, timeline, total]);

  const indexAt = useCallback(
    (clientY: number) => {
      const rect = hitRef.current?.getBoundingClientRect();
      if (!rect || rect.height <= 0 || total <= 1) return 0;
      const r = clamp01((clientY - rect.top) / rect.height);
      return Math.round(r * (total - 1));
    },
    [total],
  );

  const peek = useCallback(() => {
    setBubble(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setBubble(false);
      // Back to the real scroll position once the preview has faded.
      setActive(null);
    }, BUBBLE_HOLD_MS);
  }, []);

  const seek = useCallback(
    (next: number, announce = true) => {
      const clamped = Math.max(0, Math.min(total - 1, next));
      setActive(clamped);
      if (announce) peek();
      onSeek(clamped);
    },
    [onSeek, peek, total],
  );

  const stopHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    start.current = null;
  };

  const scheduleFade = () => {
    if (mode !== "phone") return;
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null;
      setFaded(true);
    }, PHONE_FADE_MS);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || total === 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setFaded(false);
    setActive(indexAt(event.clientY));
    // On the phone the press may become a long press; only show the bubble
    // once the gesture actually becomes a drag.
    if (mode !== "phone") peek();
    longPressed.current = false;
    start.current = { y: event.clientY };
    if (mode === "phone" && onLongPress) {
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        longPressed.current = true;
        setDragging(false);
        setActive(null);
        setBubble(false);
        onLongPress();
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (!start.current) return;
    if (Math.abs(event.clientY - start.current.y) > 8) {
      if (holdTimer.current !== null) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
    } else {
      // A press that has not moved yet is a potential long press. Do not
      // follow the pointer until it clearly becomes a drag, or the grid jumps
      // under the thumb just before the jump drawer opens.
      return;
    }
    if (longPressed.current) return;
    seek(indexAt(event.clientY));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging && !longPressed.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopHold();
    if (!longPressed.current) {
      seek(indexAt(event.clientY));
      peek();
    } else {
      setBubble(false);
      setActive(null);
    }
    longPressed.current = false;
    setDragging(false);
    scheduleFade();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (total === 0) return;
    const page = Math.max(1, step);
    let next: number | null = null;
    if (event.key === "ArrowUp") next = shownIndex - 1;
    else if (event.key === "ArrowDown") next = shownIndex + 1;
    else if (event.key === "PageUp") next = shownIndex - page;
    else if (event.key === "PageDown") next = shownIndex + page;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = total - 1;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    seek(next);
  };

  if (total === 0 || !frame || !host || frame.top >= window.innerHeight - 40) return null;

  const thumbH = mode === "phone" ? 56 : 46;
  const style = {
    top: frame.top,
    right: frame.right,
    bottom: frame.bottom,
    "--ratio": ratio,
  } as CSSProperties;

  return createPortal(
    <div
      className={`lib-scrubber ${mode}${dragging ? " dragging" : ""}${faded ? " faded" : ""}`}
      style={style}
    >
      <div className="lib-scrubber-track" aria-hidden="true" />
      {marks.map((mark) =>
        mark.label !== undefined ? (
          <span
            key={mark.key}
            className={`lib-scrubber-label${mark.year ? " year" : ""}`}
            style={{ top: `${mark.ratio * 100}%` }}
            aria-hidden="true"
          >
            {mark.label}
          </span>
        ) : (
          <span
            key={mark.key}
            className={`lib-scrubber-tick${mark.year ? " year" : ""}`}
            style={{ top: `${mark.ratio * 100}%` }}
            aria-hidden="true"
          />
        ),
      )}
      <div
        ref={hitRef}
        className="lib-scrubber-hit"
        role="scrollbar"
        tabIndex={0}
        aria-label={t("lib_scrubber")}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, total)}
        aria-valuenow={Math.min(total, shownIndex + 1)}
        aria-valuetext={bubbleText}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onKeyDown={onKeyDown}
        onFocus={() => setFaded(false)}
        onBlur={() => scheduleFade()}
      />
      <div className="lib-scrubber-thumb" aria-hidden="true">
        {mode === "phone" && (
          <>
            <Icon name="chevronUp" size="sm" />
            <Icon name="chevronDown" size="sm" />
          </>
        )}
      </div>
      {bubble && total > 0 && (
        <div
          className="lib-scrubber-bubble"
          style={{ top: `calc((100% - ${thumbH}px) * ${shownRatio} + ${thumbH / 2}px)` }}
          aria-hidden="true"
        >
          {bubbleText}
        </div>
      )}
    </div>,
    host,
  );
}

