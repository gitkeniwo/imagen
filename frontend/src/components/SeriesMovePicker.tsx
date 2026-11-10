import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SeriesOrder } from "../api";
import { clockTime, parseTime } from "../historyTime";
import { useI18n } from "../i18n";
import { currentRuns } from "../seriesOrder";
import Icon from "./ui/Icon";
import Sheet from "./ui/Sheet";

// series-v2 B4: "Move before… / Move after…" — every version of the series
// (newest first) with its #N range; expand one to target a single attempt.
// Searchable by "v4" or "#12". The moving records themselves are disabled.

const EDGE = 8;

export default function SeriesMovePicker({
  order,
  moving,
  side,
  anchorRect,
  phone,
  onPick,
  onClose,
}: {
  order: SeriesOrder;
  moving: number[];
  side: "before" | "after";
  /** Where the moved item is on screen (desktop: the panel sits next to it). */
  anchorRect: DOMRect | null;
  phone: boolean;
  onPick: (anchor: number[]) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const runs = useMemo(() => currentRuns(order), [order]);
  const item = useMemo(() => new Map(order.items.map((it) => [it.id, it])), [order]);
  const movingSet = useMemo(() => new Set(moving), [moving]);
  const home = item.get(moving[0])?.version ?? null;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  const q = query.trim().toLowerCase();
  const vMatch = /^v(\d+)$/.exec(q);
  const nMatch = /^#?(\d+)$/.exec(q);
  const list = [...runs].reverse().filter((r) => {
    if (!q) return true;
    if (vMatch) return String(r.version).startsWith(vMatch[1]);
    if (nMatch) {
      const n = Number(nMatch[1]);
      return r.ids.some((id) => item.get(id)?.seq === n);
    }
    return false;
  });
  // A "#12" search opens the versions it found.
  const expanded = (v: number) => open.has(v) || (!!nMatch && list.length <= 3);

  const title = side === "before" ? t("sv4_move_before") : t("sv4_move_after");

  const body = (
    <div className={`series-mp-body${phone ? " phone" : ""}`}>
      <input
        className="series-mp-search"
        type="search"
        value={query}
        placeholder={t("sv4_picker_search")}
        aria-label={t("sv4_picker_search")}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus={!phone}
      />
      <ul className="series-mp-list" role="listbox" aria-label={title}>
        {list.length === 0 && <li className="series-mp-empty">{t("sv4_picker_empty")}</li>}
        {list.map((r) => {
          const first = item.get(r.ids[0])!.seq;
          const last = item.get(r.ids[r.ids.length - 1])!.seq;
          const allMoving = r.ids.every((id) => movingSet.has(id));
          const isOpen = expanded(r.version);
          return (
            <li key={r.version}>
              <div className="series-mp-row">
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="series-mp-version"
                  disabled={allMoving}
                  onClick={() => onPick(r.ids)}
                >
                  <span className="series-vg-pill">{t("sv2_version_n", { k: r.version })}</span>
                  <span>{first === last ? `#${first}` : `#${first}–${last}`}</span>
                  {r.version === home && <Icon name="check" size="sm" className="series-mp-home" />}
                </button>
                {r.ids.length > 1 && (
                  <button
                    type="button"
                    className="series-mp-expand"
                    aria-expanded={isOpen}
                    aria-label={t("sv4_expand_version", { k: r.version })}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (next.has(r.version)) next.delete(r.version);
                        else next.add(r.version);
                        return next;
                      })
                    }
                  >
                    <Icon name={isOpen ? "chevronDown" : "next"} size="sm" />
                  </button>
                )}
              </div>
              {isOpen && r.ids.length > 1 && (
                <ul className="series-mp-attempts">
                  {[...r.ids].reverse().map((id) => {
                    const it = item.get(id)!;
                    const d = parseTime(it.created_at);
                    const st = it.status === "aborted" ? "aborted" : it.status;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="series-mp-attempt"
                          disabled={movingSet.has(id)}
                          onClick={() => onPick([id])}
                        >
                          <strong>#{it.seq}</strong>
                          <span>
                            {t(`status_${st}`)}
                            {d ? ` · ${clockTime(d, lang)}` : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );

  if (phone) {
    return (
      <Sheet title={title} onClose={onClose} className="series-mp-sheet">
        {body}
      </Sheet>
    );
  }
  return <FloatingPanel title={title} anchorRect={anchorRect} onClose={onClose}>{body}</FloatingPanel>;
}

/** A small fixed panel next to the moved item; closes on outside press / Esc. */
function FloatingPanel({
  title,
  anchorRect,
  onClose,
  children,
}: {
  title: string;
  anchorRect: DOMRect | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // An anchor scrolled out of view: centre the panel instead.
      const a = anchorRect && anchorRect.bottom > 0 && anchorRect.top < vh ? anchorRect : null;
      let left = a ? a.right - w : vw / 2 - w / 2;
      let top = a ? a.bottom + 6 : vh / 3 - h / 3;
      if (a && top + h > vh - EDGE) top = a.top - h - 6;
      left = Math.min(Math.max(EDGE, left), vw - w - EDGE);
      top = Math.min(Math.max(EDGE, top), vh - h - EDGE);
      setStyle({ left, top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchorRect]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="series-mp" role="dialog" aria-label={title} style={style}>
      <div className="series-mp-title">{title}</div>
      {children}
    </div>,
    document.body,
  );
}
