import {
  memo,
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
  formatMonthYear,
  indexToDay,
  phoneRulerTicks,
  type Timeline,
  type TimelineDay,
  type PhoneRulerTick,
} from "../timeline";

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

const PHONE_RULER_H = 240;

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

const PhoneRulerMarks = memo(function PhoneRulerMarks({
  ticks,
  height,
}: {
  ticks: PhoneRulerTick[];
  height: number;
}) {
  return (
    <>
      {ticks.map((tick) => (
        <span
          key={tick.key}
          className={`lib-phone-ruler-tick ${tick.kind}`}
          style={{ top: tick.ratio * height }}
          aria-hidden="true"
        />
      ))}
      {ticks.map((tick) =>
        tick.label ? (
          <span
            key={`${tick.key}-label`}
            className="lib-phone-ruler-label"
            style={{ top: tick.ratio * height }}
            aria-hidden="true"
          >
            {tick.label}
          </span>
        ) : null,
      )}
    </>
  );
});

/**
 * Timeline scrubber pinned to the right edge of the Library's scroll area.
 *
 * It is portaled into the scroller's positioned parent and offset against the
 * scroller's rect, because the Library scrolls inside the sidebar / fullscreen
 * manager / phone island. Absolute positioning keeps the rail aligned with the
 * scroller through browser zoom and pinch-zoom. The thumb is a real
 * `role="scrollbar"`: pointer capture for dragging, arrows for one row,
 * PageUp / PageDown for a screen, Home / End for the ends.
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
  const [phoneExpanded, setPhoneExpanded] = useState(false);
  const [phoneScrubbing, setPhoneScrubbing] = useState(false);
  const [bubbleTop, setBubbleTop] = useState<number | null>(null);
  const [faded, setFaded] = useState(false);
  const [height, setHeight] = useState(0);
  const holdTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const fadeTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const phoneDrag = useRef(false);
  const phoneYear = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // WebKit can emit a pointermove when a large scroll changes what is under a
  // stationary pointer. Do not let that synthetic event replace a keyboard
  // seek; only a real pointer movement should preview a new position.
  const hoverY = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    holdTimer.current = null;
    hideTimer.current = null;
    fadeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const scheduleFade = useCallback(() => {
    if (mode !== "phone") return;
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null;
      setFaded(true);
    }, PHONE_FADE_MS);
  }, [mode]);

  const showPhoneScrubber = useCallback(() => {
    if (mode !== "phone") return;
    setFaded(false);
    scheduleFade();
  }, [mode, scheduleFade]);

  useEffect(() => showPhoneScrubber(), [showPhoneScrubber]);

  useEffect(() => {
    if (mode !== "phone") return;
    const onScroll = (event: Event) => {
      if (event.target !== scrollerRef.current || start.current) return;
      showPhoneScrubber();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [mode, scrollerRef, showPhoneScrubber]);

  // Measure the scroller and sticky header so the track starts below the
  // header and ends at the scroller's bottom edge. All offsets are relative to
  // the portal host's padding box, not the viewport: pinch zoom changes the
  // visual viewport while these two elements stay in the same layout space.
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
      const hostRect = nextHost.getBoundingClientRect();
      const hostLeft = hostRect.left + nextHost.clientLeft;
      const hostTop = hostRect.top + nextHost.clientTop;
      const hostRight = hostLeft + nextHost.clientWidth;
      const hostBottom = hostTop + nextHost.clientHeight;
      const rect = scroller.getBoundingClientRect();
      const head = headerRef.current?.getBoundingClientRect();
      const top = Math.max(rect.top + 6, (head?.bottom ?? rect.top) + 6) - hostTop;
      const bottom = Math.max(0, hostBottom - rect.bottom + 6);
      const right =
        mode === "phone"
          ? hostRight - document.documentElement.clientWidth
          : Math.max(0, hostRight - rect.right + (mode === "full" ? 8 : 4));
      setHeight(Math.max(0, hostBottom - hostTop - top - bottom));
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

  const { bubbleText, phoneMonthText, phoneCountText } = useMemo(() => {
    const day: TimelineDay | null = timeline ? indexToDay(timeline, shownIndex) : null;
    const month = day ? formatMonthYear(day.day, lang) : "";
    const locale = lang === "zh" ? "zh-CN" : "en-US";
    const indexText = (shownIndex + 1).toLocaleString(locale);
    const number = `#${indexText}`;
    const count = t("lib_scrubber_count", {
      index: indexText,
      total: total.toLocaleString(locale),
    });
    return {
      bubbleText:
        mode === "phone"
          ? month
            ? `${month} · ${count}`
            : count || number
          : month
            ? `${month} · ${number}`
            : number,
      phoneMonthText: month || number,
      phoneCountText: count,
    };
  }, [lang, mode, shownIndex, t, timeline, total]);

  const marks = useMemo<Mark[]>(() => {
    if (!timeline || mode === "phone" || total <= 0) return [];
    const years: Mark[] = [];
    for (const y of timeline.years) {
      const first = timeline.yearAnchor.get(y.year) ?? -1;
      if (first >= 0) {
        years.push({
          key: `y-${y.year}`,
          ratio: clamp01(first / total),
          label: mode === "compact" ? undefined : String(y.year),
          year: true,
        });
      }
    }

    // Full screen and compact share the same rail: years are boundaries,
    // every other month is a tick, and only full screen shows the year text.
    // Year boundaries already mark January, so odd months fill the gaps.
    const months: Mark[] = timeline.years
      .flatMap((y) => y.months)
      .filter((m) => m.count > 0 && m.month % 2 === 1)
      .map((m) => ({
        key: `m-${m.key}`,
        ratio: clamp01((timeline.monthAnchor.get(m.key) ?? m.firstIndex) / total),
        year: false,
      }));
    const all = [...years, ...months].sort((a, b) => a.ratio - b.ratio);
    if (mode === "compact" || height <= 0) return all;

    // Imported rows can put two years very close together. Keep both boundary
    // lines, but hide a label that would otherwise overlap the previous one.
    let lastLabelY = -Infinity;
    return all.map((mark) => {
      const y = mark.ratio * height;
      if (!mark.year || mark.label === undefined) return mark;
      if (y - lastLabelY < 10) return { ...mark, label: undefined };
      lastLabelY = y;
      return mark;
    });
  }, [height, mode, timeline, total]);

  const phoneTicks = useMemo(
    () => (mode === "phone" ? phoneRulerTicks(timeline, total, height) : []),
    [height, mode, timeline, total],
  );

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
      setBubbleTop(null);
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

  const yearAtIndex = useCallback(
    (next: number) => {
      const day = timeline ? indexToDay(timeline, next) : null;
      return day ? Number(day.day.slice(0, 4)) : null;
    },
    [timeline],
  );

  const stopHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    start.current = null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || total === 0) return;
    event.preventDefault();
    clearTimers();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setFaded(false);
    const pressed = indexAt(event.clientY);
    setActive(pressed);
    const rect = hitRef.current?.getBoundingClientRect();
    if (mode !== "phone" && rect) {
      setBubbleTop(event.clientY - rect.top);
    } else {
      setPhoneExpanded(false);
      setPhoneScrubbing(false);
      phoneDrag.current = false;
      phoneYear.current = yearAtIndex(pressed);
    }
    // On the phone the press may become a long press; only show the bubble
    // once the gesture actually becomes a drag.
    if (mode !== "phone") peek();
    longPressed.current = false;
    start.current = { x: event.clientX, y: event.clientY };
    if (mode === "phone" && onLongPress) {
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        longPressed.current = true;
        phoneDrag.current = false;
        phoneYear.current = null;
        setDragging(false);
        setPhoneExpanded(false);
        setPhoneScrubbing(false);
        setActive(null);
        setBubble(false);
        onLongPress();
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = hitRef.current?.getBoundingClientRect();
    if (mode !== "phone" && rect) {
      const nextTop = event.clientY - rect.top;
      setBubbleTop((prev) => (prev !== null && Math.abs(prev - nextTop) < 0.5 ? prev : nextTop));
    }
    if (!dragging) {
      // The bubble is the only month readout on the rail now, so preview the
      // position under the pointer without moving the thumb.
      if (mode !== "phone") {
        const moved = hoverY.current === null || Math.abs(event.clientY - hoverY.current) > 0.5;
        hoverY.current = event.clientY;
        if (hideTimer.current !== null) {
          window.clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        setBubble(true);
        if (moved) setActive(indexAt(event.clientY));
      }
      return;
    }
    if (!start.current) return;
    const distance = Math.hypot(
      event.clientX - start.current.x,
      event.clientY - start.current.y,
    );
    if (distance > 8) {
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
    const next = indexAt(event.clientY);
    if (mode === "phone") {
      if (!phoneDrag.current) {
        phoneDrag.current = true;
        setPhoneExpanded(true);
        setPhoneScrubbing(true);
      }
      const nextYear = yearAtIndex(next);
      if (phoneYear.current !== null && nextYear !== null && nextYear !== phoneYear.current) {
        try {
          navigator.vibrate?.(5);
        } catch {
          // Browsers may expose the API but reject it in this context.
        }
      }
      phoneYear.current = nextYear;
      seek(next, false);
    } else {
      seek(next);
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging && !longPressed.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopHold();
    const wasLongPress = longPressed.current;
    const wasPhoneDrag = phoneDrag.current;
    longPressed.current = false;
    phoneDrag.current = false;
    phoneYear.current = null;
    setDragging(false);
    setPhoneScrubbing(false);

    if (wasLongPress) {
      setBubble(false);
      setPhoneExpanded(false);
      setActive(null);
      scheduleFade();
      return;
    }

    if (mode === "phone") {
      seek(indexAt(event.clientY), false);
      if (wasPhoneDrag) {
        setPhoneExpanded(true);
        hideTimer.current = window.setTimeout(() => {
          hideTimer.current = null;
          setPhoneExpanded(false);
          setActive(null);
          scheduleFade();
        }, BUBBLE_HOLD_MS);
      } else {
        setPhoneExpanded(false);
        setActive(null);
        scheduleFade();
      }
      return;
    }

    seek(indexAt(event.clientY));
    peek();
  };

  const onPointerLeave = () => {
    if (dragging || mode === "phone") return;
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setBubble(false);
    setBubbleTop(null);
    setActive(null);
    hoverY.current = null;
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

  if (total === 0 || !frame || !host || height < 40) return null;

  const thumbH = mode === "phone" ? 44 : 46;
  const thumbTop = (height - thumbH) * ratio;
  const thumbBottom = thumbTop + thumbH;
  const visibleMarks = marks.filter((mark) => {
    const y = mark.ratio * height;
    return y < thumbTop - 4 || y > thumbBottom + 4;
  });
  const rulerY =
    (height - thumbH) * shownRatio + thumbH / 2 - PHONE_RULER_H / 2;
  const style = {
    top: frame.top,
    right: frame.right,
    bottom: frame.bottom,
    "--ratio": mode === "phone" ? shownRatio : ratio,
  } as CSSProperties;

  return createPortal(
    <div
      className={`lib-scrubber ${mode}${dragging ? " dragging" : ""}${faded ? " faded" : ""}${
        phoneScrubbing ? " scrubbing" : ""
      }${phoneExpanded ? " expanded" : ""}`}
      style={style}
    >
      <div className="lib-scrubber-track" aria-hidden="true" />
      {visibleMarks.map((mark) => (
        <span
          key={mark.key}
          className={`lib-scrubber-tick${mark.year ? " year" : ""}`}
          style={{ top: `${mark.ratio * 100}%` }}
          aria-hidden="true"
        />
      ))}
      {marks.map((mark) =>
        mark.label !== undefined ? (
          <span
            key={`${mark.key}-label`}
            className="lib-scrubber-label"
            style={{ top: `${mark.ratio * 100}%` }}
            aria-hidden="true"
          >
            {mark.label}
          </span>
        ) : null,
      )}
      {mode === "phone" && (
        <div
          className={`lib-phone-ruler${phoneScrubbing ? " on" : ""}`}
          style={{ transform: `translate3d(0, ${rulerY}px, 0)` }}
          aria-hidden="true"
        >
          <div
            className="lib-phone-ruler-track"
            style={{ transform: `translate3d(0, ${-rulerY}px, 0)` }}
          >
            <PhoneRulerMarks ticks={phoneTicks} height={height} />
          </div>
        </div>
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
        onPointerEnter={onPointerMove}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        onFocus={() => setFaded(false)}
        onBlur={() => scheduleFade()}
      />
      <div
        className={`lib-scrubber-thumb${mode === "phone" ? " lib-phone-thumb" : ""}${
          phoneExpanded ? " expanded" : ""
        }`}
        aria-hidden="true"
      >
        {mode === "phone" && (
          <>
            <div className="lib-phone-copy">
              <span className="lib-phone-month">{phoneMonthText}</span>
              <span className="lib-phone-count">{phoneCountText}</span>
            </div>
            <span className="lib-phone-grip">
              <i />
              <i />
              <i />
            </span>
          </>
        )}
      </div>
      {mode !== "phone" && bubble && total > 0 && (
        <div
          className="lib-scrubber-bubble"
          style={{
            top: bubbleTop !== null
              ? `${bubbleTop}px`
              : `calc((100% - ${thumbH}px) * ${shownRatio} + ${thumbH / 2}px)`,
          }}
          aria-hidden="true"
        >
          {bubbleText}
        </div>
      )}
    </div>,
    host,
  );
}

