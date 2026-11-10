import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";

// series-v2 B4: drag to reorder inside a series detail, with Pointer Events
// (no library). Drop targets are elements carrying `data-drop-ids` (the
// generation ids they stand for, comma separated): an attempt row, a version
// group (all its attempts, also when the filter hides them). The innermost
// target under the pointer wins, so a row of an expanded version beats its
// group. Above the target's middle = visually above it.

/** Pixels the pointer must travel before a press becomes a drag. */
const THRESHOLD = 4;
/** Auto-scroll zone at the scroller's top / bottom edge. */
const EDGE = 48;
const MAX_SPEED = 18;

export interface DragSource {
  ids: number[];
  /** Up to two thumbnail URLs for the lifted stack. */
  thumbs: string[];
}

export interface DropHit {
  /** The target's ids (not yet minus the moving ones). */
  anchor: number[];
  /** Visual side; the detail shows newest first, so "above" = later. */
  above: boolean;
}

export interface DragState {
  ids: Set<number>;
  thumbs: string[];
  x: number;
  y: number;
  /** Insertion line, viewport coordinates; null = no valid drop here. */
  line: { left: number; width: number; top: number } | null;
  zone: "up" | "down" | null;
  zoneRect: { left: number; width: number; top: number; height: number } | null;
}

function scrollerOf(el: HTMLElement | null): HTMLElement {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

const idsOf = (el: HTMLElement) =>
  (el.dataset.dropIds ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

/** The innermost drop target under `y` (or the nearest one). */
function hitTest(root: HTMLElement, x: number, y: number, moving: Set<number>) {
  const els = [...root.querySelectorAll<HTMLElement>("[data-drop-ids]")];
  let best: { el: HTMLElement; rect: DOMRect } | null = null;
  let nearest: { el: HTMLElement; rect: DOMRect; d: number } | null = null;
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (!rect.height) continue;
    if (y >= rect.top && y <= rect.bottom && x >= rect.left - 80 && x <= rect.right + 80) {
      if (!best || rect.height < best.rect.height) best = { el, rect };
    } else if (!el.parentElement?.closest("[data-drop-ids]")) {
      const d = Math.min(Math.abs(y - rect.top), Math.abs(y - rect.bottom));
      if (!nearest || d < nearest.d) nearest = { el, rect, d };
    }
  }
  const hit = best ?? nearest;
  if (!hit) return null;
  const anchor = idsOf(hit.el);
  if (!anchor.length || anchor.every((id) => moving.has(id))) return null;
  const above = y < hit.rect.top + hit.rect.height / 2;
  return { anchor, above, rect: hit.rect };
}

export function useReorderDrag({
  root,
  enabled,
  canDrop,
  onDrop,
}: {
  root: HTMLElement | null;
  enabled: boolean;
  /** Whether dropping here changes anything (no line otherwise). */
  canDrop: (ids: number[], hit: DropHit) => boolean;
  onDrop: (ids: number[], hit: DropHit) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const live = useRef<{
    source: DragSource;
    startX: number;
    startY: number;
    started: boolean;
    x: number;
    y: number;
    hit: DropHit | null;
    raf: number;
    scroller: HTMLElement | null;
    pointerId: number;
  } | null>(null);
  const cbs = useRef({ canDrop, onDrop });
  cbs.current = { canDrop, onDrop };

  const finish = useCallback(() => {
    const s = live.current;
    if (s) cancelAnimationFrame(s.raf);
    live.current = null;
    setDrag(null);
    document.body.classList.remove("series-dragging");
  }, []);

  const update = useCallback(() => {
    const s = live.current;
    if (!s || !root) return;
    const moving = new Set(s.source.ids);
    const found = hitTest(root, s.x, s.y, moving);
    const hit = found && cbs.current.canDrop(s.source.ids, found) ? found : null;
    s.hit = hit ? { anchor: hit.anchor, above: hit.above } : null;
    const scroller = s.scroller;
    const box =
      scroller && scroller !== document.scrollingElement
        ? scroller.getBoundingClientRect()
        : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const zone = s.y < box.top + EDGE ? "up" : s.y > box.bottom - EDGE ? "down" : null;
    const rootBox = root.getBoundingClientRect();
    setDrag({
      ids: moving,
      thumbs: s.source.thumbs,
      x: s.x,
      y: s.y,
      line: found && hit
        ? {
            left: found.rect.left,
            width: found.rect.width,
            top: found.above ? found.rect.top - 6 : found.rect.bottom + 6,
          }
        : null,
      zone,
      zoneRect: zone
        ? {
            left: rootBox.left,
            width: rootBox.width,
            top: zone === "up" ? Math.max(box.top, 0) : Math.min(box.bottom, window.innerHeight) - EDGE,
            height: EDGE,
          }
        : null,
    });
  }, [root]);

  // Auto-scroll while the pointer rests in an edge zone.
  const tick = useCallback(() => {
    const s = live.current;
    if (!s || !s.started) return;
    const scroller = s.scroller;
    if (scroller) {
      const box =
        scroller === document.scrollingElement
          ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
          : scroller.getBoundingClientRect();
      let dy = 0;
      if (s.y < box.top + EDGE) dy = -Math.ceil(((box.top + EDGE - s.y) / EDGE) * MAX_SPEED);
      else if (s.y > box.bottom - EDGE) dy = Math.ceil(((s.y - (box.bottom - EDGE)) / EDGE) * MAX_SPEED);
      if (dy) {
        const before = scroller.scrollTop;
        scroller.scrollTop += dy;
        if (scroller.scrollTop !== before) update();
      }
    }
    s.raf = requestAnimationFrame(tick);
  }, [update]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = live.current;
      if (!s || e.pointerId !== s.pointerId) return;
      s.x = e.clientX;
      s.y = e.clientY;
      if (!s.started) {
        if (Math.hypot(s.x - s.startX, s.y - s.startY) < THRESHOLD) return;
        s.started = true;
        document.body.classList.add("series-dragging");
        s.raf = requestAnimationFrame(tick);
      }
      e.preventDefault();
      update();
    };
    const up = (e: PointerEvent) => {
      const s = live.current;
      if (!s || e.pointerId !== s.pointerId) return;
      const { started, hit, source } = s;
      finish();
      if (started && hit) cbs.current.onDrop(source.ids, hit);
    };
    const cancel = () => {
      if (live.current) finish();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && live.current?.started) {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
    };
  }, [finish, tick, update]);

  useEffect(() => () => finish(), [finish]);

  /** Pointer-down on a grip: arms the drag (it starts after a few px). */
  const start = useCallback(
    (e: ReactPointerEvent, source: DragSource) => {
      if (!enabled || e.button !== 0 || !source.ids.length) return;
      e.preventDefault();
      e.stopPropagation();
      live.current = {
        source,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        x: e.clientX,
        y: e.clientY,
        hit: null,
        raf: 0,
        scroller: scrollerOf(root),
        pointerId: e.pointerId,
      };
    },
    [enabled, root],
  );

  return { drag, start };
}
