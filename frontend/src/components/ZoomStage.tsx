import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ImageRow, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { IconButton } from "./ui/Button";
import Icon from "./ui/Icon";

// Zoomable image stage for the viewer. Zoom stays clipped inside the stage,
// never over the inspector.
// - Scale is in image pixels → screen pixels; "fit" is the largest scale that
//   shows the whole image (never above 1:1), and zoom is capped at 8× fit.
// - Pinch: WebKit `gesture*` events (WKWebView, Safari) and Chromium's
//   ctrl+wheel; both are cancelled so the app's own page zoom never kicks in.
//   Two-finger scroll and mouse drag pan; double-click toggles Fit ↔ 1:1.
// - Only the wrapper's transform changes; updates are batched per frame and
//   `will-change` is set only while a gesture is running.
// - The thumbnail paints first; the original is decoded off-screen
//   (img.decode()) and swapped in so a large file never blocks a frame.

const PAD = 24;
const MAX_FIT_MULT = 8;
const STEP = 1.5;

interface View {
  s: number;
  x: number;
  y: number;
}

export default function ZoomStage({
  image,
  panelHidden,
  onTogglePanel,
  onZoomedChange,
  children,
}: {
  image: ImageRow;
  panelHidden: boolean;
  onTogglePanel: () => void;
  onZoomedChange: (zoomed: boolean) => void;
  // Overlays drawn above the image (counter, prev/next).
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [moving, setMoving] = useState(false);
  const [src, setSrc] = useState(() => imgThumbUrl(image.id));
  const viewRef = useRef(view);
  const pending = useRef<View | null>(null);
  const frame = useRef(0);
  const idle = useRef<number | undefined>(undefined);

  const iw = image.width || 1;
  const ih = image.height || 1;
  const fit = size.w && size.h
    ? Math.min(1, (size.w - PAD * 2) / iw, (size.h - PAD * 2) / ih)
    : 1;
  const minS = fit;
  const maxS = Math.max(1, fit * MAX_FIT_MULT);

  // Keep the image centred on an axis where it is smaller than the stage,
  // otherwise keep the stage covered.
  const clamp = useCallback(
    (v: View): View => {
      const s = Math.min(maxS, Math.max(minS, v.s));
      const w = iw * s;
      const h = ih * s;
      const x = w <= size.w ? (size.w - w) / 2 : Math.min(0, Math.max(size.w - w, v.x));
      const y = h <= size.h ? (size.h - h) / 2 : Math.min(0, Math.max(size.h - h, v.y));
      return { s, x, y };
    },
    [iw, ih, minS, maxS, size.w, size.h],
  );

  const commit = useCallback((v: View) => {
    pending.current = v;
    viewRef.current = v;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current) setView(pending.current);
    });
  }, []);

  // Mark a gesture as running (will-change) until input goes quiet.
  const nudge = useCallback(() => {
    setMoving(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setMoving(false), 160);
  }, []);

  const zoomAt = useCallback(
    (s: number, px: number, py: number) => {
      const cur = viewRef.current;
      const next = Math.min(maxS, Math.max(minS, s));
      const k = next / cur.s;
      commit(clamp({ s: next, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k }));
    },
    [clamp, commit, minS, maxS],
  );

  const toFit = useCallback(() => commit(clamp({ s: minS, x: 0, y: 0 })), [clamp, commit, minS]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
    const ro = new ResizeObserver(([e]) => {
      setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // New image or resized stage: back to fit (resizing while zoomed keeps the
  // zoom but re-clamps).
  const lastId = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!size.w) return;
    const cur = viewRef.current;
    const atFit = lastId.current !== image.id || Math.abs(cur.s - minS) < 1e-3 || cur.s < minS;
    lastId.current = image.id;
    const v = atFit ? clamp({ s: minS, x: 0, y: 0 }) : clamp(cur);
    viewRef.current = v;
    setView(v);
  }, [image.id, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Thumbnail first, then the decoded original.
  useEffect(() => {
    let alive = true;
    setSrc(imgThumbUrl(image.id));
    const full = new Image();
    full.src = imgFileUrl(image.id);
    full
      .decode()
      .then(() => alive && setSrc(full.src))
      .catch(() => alive && setSrc(imgFileUrl(image.id)));
    return () => {
      alive = false;
    };
  }, [image.id]);

  const zoomed = view.s > minS + 1e-3;
  useEffect(() => onZoomedChange(zoomed), [zoomed, onZoomedChange]);

  // Native listeners: wheel and gesture events must be non-passive to cancel.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let gestureStart = 1;
    let inGesture = false;
    const local = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return [cx - r.left, cy - r.top] as const;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (inGesture) return;
        nudge();
        const [px, py] = local(e.clientX, e.clientY);
        zoomAt(viewRef.current.s * Math.exp(-e.deltaY * 0.01), px, py);
        return;
      }
      if (viewRef.current.s <= minS + 1e-3) return;
      e.preventDefault();
      nudge();
      const cur = viewRef.current;
      commit(clamp({ s: cur.s, x: cur.x - e.deltaX, y: cur.y - e.deltaY }));
    };
    type GestureEvt = UIEvent & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      inGesture = true;
      gestureStart = viewRef.current.s;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvt;
      nudge();
      const [px, py] = local(g.clientX, g.clientY);
      zoomAt(gestureStart * g.scale, px, py);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      inGesture = false;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [clamp, commit, minS, nudge, zoomAt]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(idle.current);
    },
    [],
  );

  // Mouse/pen drag to pan while zoomed.
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomed || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const cur = viewRef.current;
    nudge();
    commit(clamp({ s: cur.s, x: cur.x + e.clientX - d.x, y: cur.y + e.clientY - d.y }));
    d.x = e.clientX;
    d.y = e.clientY;
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (zoomed) toFit();
    else zoomAt(minS < 1 ? 1 : minS * 2, e.clientX - r.left, e.clientY - r.top);
  };

  const center = () => [size.w / 2, size.h / 2] as const;
  const pct = Math.round(view.s * 100);
  const isFit = !zoomed;
  const isOne = Math.abs(view.s - 1) < 1e-3;

  // Minimap: visible region in image fractions.
  const mini = zoomed
    ? {
        left: Math.max(0, -view.x / (iw * view.s)) * 100,
        top: Math.max(0, -view.y / (ih * view.s)) * 100,
        width: Math.min(1, size.w / (iw * view.s)) * 100,
        height: Math.min(1, size.h / (ih * view.s)) * 100,
      }
    : null;
  const miniW = 120;
  const miniH = Math.round((miniW * ih) / iw);

  return (
    <div
      ref={stageRef}
      className={`viewer-stage${zoomed ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      <div
        className="zoom-layer"
        style={{
          width: iw,
          height: ih,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          willChange: moving || dragging ? "transform" : undefined,
          visibility: size.w ? undefined : "hidden",
        }}
      >
        <img src={src} alt={image.filename} draggable={false} />
      </div>

      {children}

      {mini && (
        <div className="zoom-mini" style={{ width: miniW, height: Math.min(miniH, 120) }} aria-hidden="true">
          <img src={imgThumbUrl(image.id)} alt="" />
          <span
            style={{
              left: `${mini.left}%`,
              top: `${mini.top}%`,
              width: `${mini.width}%`,
              height: `${mini.height}%`,
            }}
          />
        </div>
      )}

      <div className="zoom-hud" role="toolbar" aria-label={t("zoom_toolbar")}>
        <IconButton
          icon="zoomOut"
          label={t("zoom_out")}
          disabled={!zoomed}
          onClick={() => zoomAt(view.s / STEP, ...center())}
        />
        <span className="zoom-pct">{pct}%</span>
        <IconButton
          icon="zoomIn"
          label={t("zoom_in")}
          disabled={view.s >= maxS - 1e-3}
          onClick={() => zoomAt(view.s * STEP, ...center())}
        />
        <span className="zoom-sep" aria-hidden="true" />
        <button type="button" className="zoom-text" aria-pressed={isFit} onClick={toFit}>
          {t("zoom_fit")}
        </button>
        <button
          type="button"
          className="zoom-text"
          aria-pressed={isOne}
          onClick={() => zoomAt(1, ...center())}
        >
          1:1
        </button>
        <span className="zoom-sep" aria-hidden="true" />
        <button
          type="button"
          className="zoom-icon"
          aria-pressed={panelHidden}
          aria-label={panelHidden ? t("show_panel") : t("hide_panel")}
          title={`${panelHidden ? t("show_panel") : t("hide_panel")} (I)`}
          onClick={onTogglePanel}
        >
          <Icon name="togglePanel" size="sm" />
        </button>
      </div>
    </div>
  );
}
