import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ImageRow, imgFileUrl, imgThumbUrl } from "../api";
import { useI18n } from "../i18n";
import { IconButton } from "./ui/Button";
import Icon from "./ui/Icon";

// Zoomable image stage for the viewer. Zoom stays clipped inside the stage,
// never over the inspector.
// - Scale is in image pixels → screen pixels; "fit" shows the whole image and
//   fills the stage on its limiting axis. Zoom is capped at 8× fit.
// - Pinch: WebKit `gesture*` events (WKWebView, Safari) and Chromium's
//   ctrl+wheel; both are cancelled so the app's own page zoom never kicks in.
//   Two-finger scroll and mouse drag pan; double-click zooms in from Fit and
//   returns to Fit from any zoomed state.
// - Only the wrapper's transform changes; updates are batched per frame and
//   `will-change` is set only while a gesture is running.
// - The thumbnail paints first; the original is decoded off-screen
//   (img.decode()) and swapped in so a large file never blocks a frame.

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
  starred,
  onToggleStar,
  onTogglePanel,
  onZoomedChange,
  onNavigate,
  canNavigatePrev = true,
  canNavigateNext = true,
  children,
}: {
  image: ImageRow;
  panelHidden: boolean;
  starred: boolean;
  onToggleStar: () => void;
  onTogglePanel: () => void;
  onZoomedChange: (zoomed: boolean) => void;
  // Fit only: horizontal swipe/flick to the previous (-1) or next (+1) image.
  onNavigate?: (delta: -1 | 1) => void;
  canNavigatePrev?: boolean;
  canNavigateNext?: boolean;
  // Overlays drawn above the image (counter, prev/next).
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [moving, setMoving] = useState(false);
  const [src, setSrc] = useState(() => imgThumbUrl(image));
  const viewRef = useRef(view);
  const atFitRef = useRef(true);
  const pending = useRef<View | null>(null);
  const frame = useRef(0);
  const idle = useRef<number | undefined>(undefined);
  const wheelSwipe = useRef({ dx: 0, last: 0, lockedUntil: 0 });
  const gestureActive = useRef(false);
  const activeTouches = useRef(new Set<number>());
  const swipe = useRef<{
    id: number;
    x: number;
    y: number;
    startedAt: number;
    moved: boolean;
    captured: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const suppressClickTimer = useRef<number | undefined>(undefined);

  const iw = image.width || 1;
  const ih = image.height || 1;
  const fit = size.w && size.h ? Math.min(size.w / iw, size.h / ih) : 1;
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

  const toFit = useCallback(() => {
    atFitRef.current = true;
    commit(clamp({ s: minS, x: 0, y: 0 }));
  }, [clamp, commit, minS]);

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
    const atFit =
      lastId.current !== image.id ||
      atFitRef.current ||
      Math.abs(cur.s - minS) < 1e-3 ||
      cur.s < minS;
    lastId.current = image.id;
    const v = atFit ? clamp({ s: minS, x: 0, y: 0 }) : clamp(cur);
    viewRef.current = v;
    setView(v);
    atFitRef.current = Math.abs(v.s - minS) < 1e-3;
  }, [image.id, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    atFitRef.current = Math.abs(view.s - minS) < 1e-3;
  }, [view.s, minS]);

  // Thumbnail first, then the decoded original.
  useEffect(() => {
    let alive = true;
    setSrc(imgThumbUrl(image));
    const full = new Image();
    full.src = imgFileUrl(image);
    full
      .decode()
      .then(() => alive && setSrc(full.src))
      .catch(() => alive && setSrc(imgFileUrl(image)));
    return () => {
      alive = false;
    };
  }, [image.id, image.sha256]);

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
      if (viewRef.current.s <= minS + 1e-3) {
        if (!onNavigate) return;
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        const dx = e.deltaX * unit;
        const dy = e.deltaY * unit;
        if (Math.abs(dx) <= Math.abs(dy) * 1.15) return;

        // Trackpads report a horizontal two-finger swipe as wheel deltas.
        const direction = dx > 0 ? 1 : -1;
        if ((direction > 0 && !canNavigateNext) || (direction < 0 && !canNavigatePrev)) {
          wheelSwipe.current.dx = 0;
          return;
        }
        e.preventDefault();
        const now = performance.now();
        const s = wheelSwipe.current;
        if (now < s.lockedUntil) {
          s.lockedUntil = now + 180;
          return;
        }
        if (now - s.last > 240) s.dx = 0;
        s.dx += dx;
        s.last = now;
        const threshold = Math.max(60, Math.min(120, el.clientWidth * 0.1));
        if (Math.abs(s.dx) >= threshold) {
          onNavigate(s.dx > 0 ? 1 : -1);
          s.dx = 0;
          s.lockedUntil = now + 220;
        }
        return;
      }
      e.preventDefault();
      nudge();
      const cur = viewRef.current;
      commit(clamp({ s: cur.s, x: cur.x - e.deltaX, y: cur.y - e.deltaY }));
    };
    type GestureEvt = UIEvent & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureActive.current = true;
      swipe.current = null;
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
      gestureActive.current = false;
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
  }, [
    canNavigateNext,
    canNavigatePrev,
    clamp,
    commit,
    minS,
    nudge,
    onNavigate,
    zoomAt,
  ]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(idle.current);
    },
    [],
  );

  // Mouse/pen drag to pan while zoomed, and horizontal swipe to page while fit.
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const armClickSuppression = () => {
    suppressClick.current = true;
    window.clearTimeout(suppressClickTimer.current);
    suppressClickTimer.current = window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const endSwipe = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    swipe.current = null;
    if (s.captured && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.moved) armClickSuppression();
    const elapsed = performance.now() - s.startedAt;
    const threshold = Math.max(42, Math.min(80, size.w * 0.08));
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.25;
    const flicked =
      Math.abs(dx) >= 24 &&
      Math.abs(dx) > Math.abs(dy) * 1.5 &&
      elapsed <= 280;
    const delta = dx < 0 ? 1 : -1;
    const canNavigate = delta > 0 ? canNavigateNext : canNavigatePrev;
    if (
      onNavigate &&
      canNavigate &&
      !gestureActive.current &&
      activeTouches.current.size <= 1 &&
      viewRef.current.s <= minS + 1e-3 &&
      horizontal &&
      (Math.abs(dx) >= threshold || flicked)
    ) {
      onNavigate(delta);
    }
  };

  const cancelSwipe = () => {
    swipe.current = null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      activeTouches.current.add(e.pointerId);
      if (activeTouches.current.size > 1) cancelSwipe();
    }
    const target = e.target instanceof Element ? e.target : null;
    const zone = target?.closest(".viewer-zone");
    const noSwipe = target?.closest(
      ".viewer-phone-top, .zoom-hud, .viewer-count, .zoom-mini, " +
        "button:not(.viewer-zone), a, input, textarea, select, " +
        "[contenteditable='true'], [role='toolbar']",
    );

    if (viewRef.current.s <= minS + 1e-3) {
      cancelSwipe();
      if (
        !onNavigate ||
        (e.pointerType === "mouse" && e.button !== 0) ||
        !e.isPrimary ||
        gestureActive.current ||
        noSwipe
      ) {
        return;
      }
      swipe.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        startedAt: performance.now(),
        moved: false,
        captured: !zone,
      };
      if (!zone) e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    cancelSwipe();
    if (!zoomed || e.button !== 0 || target?.closest("button")) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (s && s.id === e.pointerId) {
      if (Math.abs(e.clientX - s.x) > 8 || Math.abs(e.clientY - s.y) > 8) {
        s.moved = true;
      }
      return;
    }
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
  const onPointerUp = (e: React.PointerEvent) => {
    endSwipe(e);
    if (e.pointerType === "touch") activeTouches.current.delete(e.pointerId);
    endDrag();
  };
  const onPointerCancel = (e: React.PointerEvent) => {
    cancelSwipe();
    if (e.pointerType === "touch") activeTouches.current.delete(e.pointerId);
    endDrag();
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    window.clearTimeout(suppressClickTimer.current);
    e.preventDefault();
    e.stopPropagation();
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button")) return;
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

  useEffect(
    () => () => {
      window.clearTimeout(suppressClickTimer.current);
    },
    [],
  );

  return (
    <div
      ref={stageRef}
      className={`viewer-stage${zoomed ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
      onDoubleClick={onDoubleClick}
    >
      <div
        key={image.id}
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
          <img src={imgThumbUrl(image)} alt="" />
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
          disabled={minS > 1 + 1e-3}
          onClick={() => zoomAt(1, ...center())}
        >
          1:1
        </button>
        <span className="zoom-sep" aria-hidden="true" />
        <IconButton
          className={`zoom-favorite${starred ? " is-starred" : ""}`}
          icon="favorite"
          filled={starred}
          label={starred ? t("unfavorite") : t("favorite")}
          aria-pressed={starred}
          onClick={onToggleStar}
        />
        <button
          type="button"
          className="zoom-icon"
          aria-pressed={panelHidden}
          aria-label={panelHidden ? t("show_panel") : t("hide_panel")}
          title={`${panelHidden ? t("show_panel") : t("hide_panel")} (I)`}
          onClick={onTogglePanel}
        >
          <Icon name={panelHidden ? "fullscreenExit" : "fullscreen"} size="sm" />
        </button>
      </div>
    </div>
  );
}
