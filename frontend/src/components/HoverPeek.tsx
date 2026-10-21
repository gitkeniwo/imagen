import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ImageRow, imgThumbUrl } from "../api";

// Hover-to-enlarge for small thumbnails (composer references, history/queue
// input chips). One floating card for the whole app: thumbnails spread
// `peekProps(img)` and <HoverPeek /> (mounted once in App) draws it.
// Mouse only — touch and pen never trigger it. The card never takes pointer
// events, so it can't cover the neighbouring thumbnail.

const SHOW_DELAY = 300;
// Leaving one thumb and entering a neighbour within this window keeps the
// card up and swaps it instantly.
const HIDE_DELAY = 90;
const MAX_W = 260;
const MAX_H = 240;
const MIN_W = 200;
const GAP = 8;
const EDGE = 8;
const TEXT_H = 30;

interface PeekState {
  img: ImageRow;
  label?: string;
  rect: DOMRect;
}

let state: PeekState | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
const listeners = new Set<() => void>();

function set(next: PeekState | null) {
  state = next;
  listeners.forEach((l) => l());
}

export function hidePeek() {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  if (state) set(null);
}

export function peekProps(img: ImageRow, label?: string) {
  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse" || e.buttons) return;
      const next = { img, label, rect: e.currentTarget.getBoundingClientRect() };
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      if (state) set(next);
      else showTimer = window.setTimeout(() => set(next), SHOW_DELAY);
    },
    onPointerLeave: () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => set(null), HIDE_DELAY);
    },
    onPointerDown: hidePeek,
    onDragStart: hidePeek,
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export default function HoverPeek() {
  const peek = useSyncExternalStore(subscribe, () => state);

  // Anything that moves the page under the pointer invalidates the anchor.
  useEffect(() => {
    if (!peek) return;
    const hide = () => hidePeek();
    window.addEventListener("scroll", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("keydown", hide);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", hide);
      window.removeEventListener("blur", hide);
    };
  }, [peek]);

  if (!peek) return null;
  const { img, label, rect } = peek;
  const w0 = img.width || 1;
  const h0 = img.height || 1;
  const scale = Math.min(MAX_W / w0, MAX_H / h0);
  const imgW = Math.round(Math.max(MIN_W, w0 * scale));
  const imgH = Math.round(Math.min(MAX_H, (imgW / w0) * h0));
  const cardW = imgW + 12;
  const cardH = imgH + 12 + TEXT_H;
  const above = rect.top - GAP - cardH >= EDGE;
  const top = above ? rect.top - GAP - cardH : Math.min(rect.bottom + GAP, window.innerHeight - cardH - EDGE);
  const left = Math.min(
    Math.max(EDGE, rect.left + rect.width / 2 - cardW / 2),
    window.innerWidth - cardW - EDGE,
  );
  const dims = img.width && img.height ? `${img.width}×${img.height}` : "";

  return createPortal(
    <div className="hover-peek" style={{ left, top, width: cardW }} aria-hidden="true">
      <img src={imgThumbUrl(img.id)} alt="" style={{ height: imgH }} />
      <div className="hover-peek-text">
        <span className="hover-peek-name">{label ? `${label} · ${img.filename}` : img.filename}</span>
        {dims && <span className="hover-peek-dims">{dims}</span>}
      </div>
    </div>,
    document.body,
  );
}
