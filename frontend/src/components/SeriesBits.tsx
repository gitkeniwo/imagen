import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { imgThumbUrl, type SeriesNode, type SeriesStats, type SeriesStatus } from "../api";
import { useI18n } from "../i18n";
import { seriesPathText, useSeries } from "../seriesStore";
import { useIsPhone } from "../useIsPhone";
import SeriesInfoCard, { type SeriesSubject } from "./SeriesInfoCard";
import { useSeriesActions } from "./SeriesMenu";
import { useSeriesNav } from "../seriesContext";
import Icon from "./ui/Icon";
import Sheet from "./ui/Sheet";

// Small pieces shared by the Series page, History cards and the composer.

export const SERIES_COLORS = [
  "#ea580c", "#ca8a04", "#16a34a", "#0891b2",
  "#2563eb", "#7c3aed", "#db2777", "#475569",
];

/** Success share of finished attempts; cancellations are left out (#39). */
export function successRate(s: Pick<SeriesStats, "success" | "blocked" | "error">): number | null {
  const finished = s.success + s.blocked + s.error;
  return finished > 0 ? Math.round((s.success / finished) * 100) : null;
}

/** Sum the stats of a set of series (theme rows, filtered views). */
export function sumStats(items: SeriesStats[]): SeriesStats {
  const out: SeriesStats = {
    tries: 0, success: 0, blocked: 0, error: 0, aborted: 0, running: 0,
    records: 0, drafts: 0, last_at: null, strip: [], cover: [],
  };
  for (const s of items) {
    out.tries += s.tries;
    out.success += s.success;
    out.blocked += s.blocked;
    out.error += s.error;
    out.aborted += s.aborted;
    out.running += s.running;
    out.records += s.records;
    out.drafts += s.drafts;
    if (s.last_at && (!out.last_at || s.last_at > out.last_at)) out.last_at = s.last_at;
  }
  out.cover = items.flatMap((s) => s.cover.slice(0, 1)).slice(0, 3);
  return out;
}

export function SeriesDot({ color, size }: { color: string | null | undefined; size?: "lg" }) {
  return (
    <span
      className={`series-dot${size === "lg" ? " lg" : ""}`}
      style={{ background: color ?? undefined }}
      aria-hidden="true"
    />
  );
}

export function StatusStrip({ strip, max = 24 }: { strip: SeriesStatus[]; max?: number }) {
  const { t } = useI18n();
  const items = strip.slice(-max);
  if (items.length === 0) return <span className="series-strip empty" aria-hidden="true" />;
  const label = items.map((s) => t(`status_${s}`)).join(", ");
  return (
    <span className="series-strip" role="img" aria-label={t("series_recent_tries", { list: label })}>
      {items.map((s, i) => (
        <i key={i} className={s} />
      ))}
    </span>
  );
}

/** Left: one large image; right: two small ones. Fewer images degrade to a
 *  single image or an empty tile. */
export function Collage({ node, size = "card" }: { node: Pick<SeriesNode, "cover">; size?: "card" | "mini" | "info" }) {
  const [a, b, c] = node.cover;
  if (!a) return <div className={`series-collage ${size} empty`} aria-hidden="true" />;
  if (!b) {
    return (
      <div className={`series-collage ${size} single`} aria-hidden="true">
        <img src={imgThumbUrl(a)} alt="" loading="lazy" draggable={false} />
      </div>
    );
  }
  return (
    <div className={`series-collage ${size}`} aria-hidden="true">
      <img className="main" src={imgThumbUrl(a)} alt="" loading="lazy" draggable={false} />
      <img src={imgThumbUrl(b)} alt="" loading="lazy" draggable={false} />
      {c ? <img src={imgThumbUrl(c)} alt="" loading="lazy" draggable={false} /> : <span />}
    </div>
  );
}

// --- series-v2 B1a: SeriesBadge --------------------------------------------

const HOVER_OPEN_MS = 400;
const HOVER_CLOSE_MS = 150;
const CARD_GAP = 6;
const CARD_EDGE = 8;

/**
 * The series pill on History / Favorites / Drafts / Queue cards and in the
 * Viewer. A real button: hover (400 ms) or click opens the SeriesInfoCard;
 * on phones a tap opens it as a sheet. "+N" counts the image's other series.
 */
export function SeriesBadge({
  seriesId,
  more = 0,
  subject,
  className,
}: {
  seriesId: number;
  more?: number;
  subject: SeriesSubject;
  className?: string;
}) {
  const { t } = useI18n();
  const { get } = useSeries();
  const phone = useIsPhone();
  const path = get(seriesId);
  const actions = useSeriesActions(useSeriesNav().onChanged);
  const [open, setOpen] = useState<null | "hover" | "pinned">(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clearTimers = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);
  const close = useCallback((restoreFocus = false) => {
    clearTimers();
    setOpen(null);
    if (restoreFocus) btnRef.current?.focus();
  }, []);
  if (!path) return null;
  const pathText = seriesPathText(path, t("series_no_theme"));
  const scheduleClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen((o) => (o === "hover" ? null : o)), HOVER_CLOSE_MS);
  };
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={["series-badge", path.archived ? "archived" : "", className].filter(Boolean).join(" ")}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-label={t("sv2_badge_aria", { theme: path.theme?.name ?? t("series_no_theme"), series: path.name })}
        title={path.archived ? `${pathText} · ${t("sv2_badge_archived")}` : pathText}
        data-series-id={seriesId}
        onPointerDown={stop}
        onContextMenu={stop}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && open) close(true);
        }}
        onPointerEnter={(e) => {
          if (phone || e.pointerType !== "mouse") return;
          if (closeTimer.current) window.clearTimeout(closeTimer.current);
          if (open || openTimer.current) return;
          openTimer.current = window.setTimeout(() => {
            openTimer.current = null;
            setOpen((o) => o ?? "hover");
          }, HOVER_OPEN_MS);
        }}
        onPointerLeave={() => {
          if (openTimer.current) window.clearTimeout(openTimer.current);
          openTimer.current = null;
          if (open === "hover") scheduleClose();
        }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          clearTimers();
          setOpen((o) => (o === "pinned" ? null : "pinned"));
        }}
      >
        {path.archived && <Icon name="archive" size="sm" />}
        <SeriesDot color={path.color} />
        <span className="series-badge-name">{path.name}</span>
        {more > 0 && (
          <span className="series-badge-more" title={t("sv2_badge_more", { n: more })}>
            +{more}
          </span>
        )}
      </button>
      {open &&
        (phone ? (
          <Sheet title={path.name} onClose={() => close(true)} hideHead grabDraggable className="sv2-sheet">
            <SeriesInfoCard subject={subject} actions={actions} variant="sheet" onClose={() => close(false)} />
          </Sheet>
        ) : (
          <BadgePopover
            anchor={btnRef}
            onClose={close}
            onPointerEnter={() => {
              if (closeTimer.current) window.clearTimeout(closeTimer.current);
            }}
            onPointerLeave={() => {
              if (open === "hover") scheduleClose();
            }}
          >
            <SeriesInfoCard subject={subject} actions={actions} variant="popover" onClose={() => close(false)} />
          </BadgePopover>
        ))}
      {actions.dialog}
    </>
  );
}

/** Fixed, portaled panel under the badge (flips above when there is no room). */
export function BadgePopover({
  anchor,
  onClose,
  children,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ position: "fixed", visibility: "hidden", top: 0, left: 0 });

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!a || !panel) return;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const left = Math.max(CARD_EDGE, Math.min(a.left, window.innerWidth - w - CARD_EDGE));
      const below = a.bottom + CARD_GAP;
      const above = a.top - CARD_GAP - h;
      const top = below + h > window.innerHeight - CARD_EDGE && above >= CARD_EDGE
        ? above
        : Math.max(CARD_EDGE, Math.min(below, window.innerHeight - h - CARD_EDGE));
      setPos({ position: "fixed", top, left });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) return;
      // Menus/dialogs opened from inside the card are portaled elsewhere.
      if ((target as Element).closest?.(".context-menu, .overlay, .series-popover")) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      className="sv2-popover"
      role="dialog"
      style={pos}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
