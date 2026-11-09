import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  firstVisibleRowAtY as geometryFirstVisibleRowAtY,
  itemTop as geometryItemTop,
  rowAtY as geometryRowAtY,
  rowTop as geometryRowTop,
  sectionRowsFor,
  totalGridHeight,
  type VirtualGridGeometry,
} from "./virtualGridGeometry";

/**
 * Row virtualization for a grid of fixed-height items inside an existing
 * scroll container (the sidebar, the fullscreen manager body, the phone
 * island …).
 *
 * The grid's own element is a placeholder whose height is the exact height of
 * every row (`rows × rowHeight − gap`), so the scrollbar length never changes
 * while data streams in. Only the rows near the viewport are rendered, inside
 * one window element moved with `translateY`; the number of tiles in the DOM
 * depends on the viewport, not on `count`.
 *
 * Geometry is deterministic: `tileWidth = (width − gap·(cols − 1)) / cols`
 * and `rowHeight = itemHeight(tileWidth) + gap`. The gap is read from the
 * window's computed `column-gap`; item and section heights can be read from
 * CSS by the caller, so CSS stays the single source of truth.
 */

export type ScrollAlign = "start" | "nearest" | "center";

export interface GridAnchor {
  index: number;
  // Distance from the top of the visible area to the top of the anchor's row.
  offset: number;
}

export interface VirtualGridOptions {
  count: number;
  // Fixed column count (sidebar / phone). Without it, columns are computed
  // like CSS `auto-fill`: floor((width + gap) / (minTile + gap)).
  columns?: number;
  minTile?: number;
  // Height of one item (not including the row gap). The default is a square
  // tile. Pages read fixed card heights from CSS here so the first render's
  // scrollbar length is already exact.
  itemHeight?: (tileWidth: number, windowEl: HTMLDivElement | null) => number;
  // Item indexes where a full-width section heading starts. Used by History's
  // list view; grid views pass none.
  sections?: number[];
  sectionHeaderHeight?: number | ((windowEl: HTMLDivElement | null) => number);
  // Height hidden under sticky headers at the top of the scroller.
  topInset?: (scroller: HTMLElement) => number;
}

function scrollParent(el: HTMLElement | null): HTMLElement {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

interface Metrics {
  width: number;
  viewport: number;
  gap: number;
  // Scroll position relative to the grid's top, measured below the inset.
  viewTop: number;
}

export function useVirtualGrid({
  count,
  columns,
  minTile = 170,
  itemHeight,
  sections,
  sectionHeaderHeight,
  topInset,
}: VirtualGridOptions) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const insetRef = useRef(topInset);
  insetRef.current = topInset;
  const [m, setM] = useState<Metrics>({ width: 0, viewport: 0, gap: 10, viewTop: 0 });

  const cols = Math.max(1, columns ?? Math.floor((m.width + m.gap) / (minTile + m.gap)));
  const tileWidth = m.width > 0 ? (m.width - m.gap * (cols - 1)) / cols : 0;
  const rawItemHeight =
    tileWidth > 0
      ? itemHeight?.(tileWidth, windowRef.current) ?? tileWidth
      : 0;
  const itemPx = Math.max(0, rawItemHeight);
  const rowHeight = itemPx > 0 ? itemPx + m.gap : 0;
  const rows = Math.ceil(count / cols);
  const rawHeaderHeight =
    typeof sectionHeaderHeight === "function"
      ? sectionHeaderHeight(windowRef.current)
      : sectionHeaderHeight ?? 0;
  const headerHeight = Math.max(0, rawHeaderHeight);
  const sectionRows = useMemo(
    () => sectionRowsFor(count, cols, sections),
    [cols, count, sections],
  );
  const geometry: VirtualGridGeometry = {
    count,
    cols,
    rowHeight,
    itemHeight: itemPx,
    headerHeight,
    sections: sections ?? [],
    sectionRows,
  };
  const totalHeight = totalGridHeight(geometry, m.gap);

  // Geometry used by imperative helpers between renders.
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  const inset = () => {
    const scroller = scrollerRef.current;
    return scroller ? Math.max(0, insetRef.current?.(scroller) ?? 0) : 0;
  };

  /** Grid top in the scroller's content coordinates. */
  const gridTop = useCallback(() => {
    const grid = gridRef.current;
    const scroller = scrollerRef.current;
    if (!grid || !scroller) return 0;
    if (scroller === document.scrollingElement) {
      return grid.getBoundingClientRect().top + window.scrollY;
    }
    return grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }, []);

  const measure = useCallback(() => {
    const grid = gridRef.current;
    const scroller = scrollerRef.current;
    if (!grid || !scroller) return;
    const win = windowRef.current;
    const gapRaw = win ? parseFloat(getComputedStyle(win).columnGap) : NaN;
    const gap = Number.isFinite(gapRaw) ? gapRaw : 10;
    const width = grid.clientWidth;
    // A hidden panel (the phone tab bar keeps them mounted) reports 0; fall
    // back to the window so the first screen is ready when it is shown.
    const viewport = (scroller.clientHeight || window.innerHeight) - inset();
    const viewTop = scroller.scrollTop - gridTop() + inset();
    setM((prev) =>
      prev.width === width &&
      prev.gap === gap &&
      prev.viewport === viewport &&
      Math.abs(prev.viewTop - viewTop) < 1
        ? prev
        : { width, gap, viewport, viewTop },
    );
  }, [gridTop]);

  // The first visible tile, kept up to date so a change of density or width
  // can put it back where it was.
  const anchorRef = useRef<GridAnchor | null>(null);
  const readAnchor = useCallback((): GridAnchor | null => {
    const scroller = scrollerRef.current;
    const { cols: c, itemHeight: ih, count: n } = geometryRef.current;
    if (!scroller || ih <= 0 || n === 0) return null;
    const viewTop = scroller.scrollTop - gridTop() + inset();
    const row = Math.max(0, geometryRowAtY(geometryRef.current, Math.max(0, viewTop)));
    const index = Math.min(n - 1, row * c);
    return { index, offset: geometryItemTop(geometryRef.current, index) - viewTop };
  }, [gridTop]);

  // Keeps the remembered tile while it is still in the top row: a density
  // change only knows the row, and re-reading the row's first tile after
  // each change would walk the anchor a few tiles per switch.
  const trackAnchor = useCallback(() => {
    const next = readAnchor();
    const prev = anchorRef.current;
    const c = geometryRef.current.cols;
    if (next && prev && Math.floor(prev.index / c) === Math.floor(next.index / c)) {
      anchorRef.current = { index: prev.index, offset: next.offset };
    } else anchorRef.current = next;
  }, [readAnchor]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const scroller = scrollParent(grid);
    scrollerRef.current = scroller;
    // One update per frame. A frame that never comes (a hidden or throttled
    // webview) must not stall every later update, so a timer races it.
    let frame = 0;
    let timer = 0;
    const run = () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
      frame = 0;
      timer = 0;
      measure();
      trackAnchor();
    };
    const onScroll = () => {
      if (frame || timer) return;
      frame = requestAnimationFrame(run);
      timer = window.setTimeout(run, 50);
    };
    const target: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
    target.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(grid);
    ro.observe(scroller);
    measure();
    return () => {
      target.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
  }, [measure, trackAnchor]);

  const setScrollTop = useCallback((top: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, top);
  }, []);

  /** Puts the row of `anchor.index` back at `anchor.offset` below the inset. */
  const restoreAnchor = useCallback(
    (anchor: GridAnchor) => {
      const { itemHeight: ih } = geometryRef.current;
      if (ih <= 0) return;
      setScrollTop(
        gridTop() +
          geometryItemTop(geometryRef.current, anchor.index) -
          anchor.offset -
          inset(),
      );
    },
    [gridTop, setScrollTop],
  );

  // Columns or tile size changed (density buttons, window or sidebar resize):
  // keep the first visible tile in place instead of keeping the pixel offset.
  const prevGeo = useRef({ cols, itemPx });
  useLayoutEffect(() => {
    const prev = prevGeo.current;
    prevGeo.current = { cols, itemPx };
    if (prev.itemPx <= 0 || (prev.cols === cols && Math.abs(prev.itemPx - itemPx) < 0.5)) return;
    const anchor = anchorRef.current;
    if (!anchor || anchor.index === 0) return;
    // Scale the in-row offset to the new card height.
    restoreAnchor({ index: anchor.index, offset: (anchor.offset * itemPx) / prev.itemPx });
    trackAnchor();
  }, [cols, itemPx, trackAnchor, restoreAnchor]);

  /** Scrolls so that tile `index` is visible. */
  const scrollToIndex = useCallback(
    (index: number, align: ScrollAlign = "start", smooth = false) => {
      const scroller = scrollerRef.current;
      const { cols: c, itemHeight: ih, count: n } = geometryRef.current;
      if (!scroller || ih <= 0 || n === 0) return;
      const i = Math.min(n - 1, Math.max(0, index));
      const row = Math.floor(i / c);
      const top = gridTop() + geometryRowTop(geometryRef.current, row);
      const tile = ih + m.gap;
      const visTop = scroller.scrollTop + inset();
      const visBottom = scroller.scrollTop + scroller.clientHeight;
      let next: number | null = null;
      if (align === "start") next = top - inset();
      else if (align === "center") next = top - inset() - (scroller.clientHeight - inset() - tile) / 2;
      else if (top < visTop) next = top - inset();
      else if (top + tile > visBottom) next = top + tile - scroller.clientHeight;
      if (next === null) return;
      scroller.scrollTo({ top: Math.max(0, next), behavior: smooth ? "smooth" : "auto" });
    },
    [gridTop, m.gap],
  );

  const scrollToTop = useCallback(
    (smooth = false) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      // The grid is at the top of the scroller's content except for headers.
      scroller.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
    },
    [],
  );

  // Visible and rendered rows. Overscan is about one screen each way.
  const firstVisibleRow =
    rowHeight > 0
      ? geometryFirstVisibleRowAtY(geometry, Math.max(0, m.viewTop))
      : 0;
  const lastVisibleRow =
    rowHeight > 0
      ? Math.max(
          firstVisibleRow,
          geometryRowAtY(geometry, m.viewTop + m.viewport - 1),
        )
      : 0;
  const overscan = rowHeight > 0 ? Math.max(2, Math.ceil(m.viewport / rowHeight)) : 2;
  const startRow = rows === 0 ? 0 : Math.min(rows - 1, Math.max(0, firstVisibleRow - overscan));
  const endRow = rows === 0 ? -1 : Math.min(rows - 1, lastVisibleRow + overscan);

  // Without a measured width nothing can be laid out yet; render one screen
  // worth of rows so the first paint has something to show.
  const measured = m.width > 0;

  // A label or toolbar can change height without resizing the grid or scroller
  // (for example Drafts' sticky header after a jump). Re-read the inset after
  // every commit so visibleStart and visibleEnd follow that layout change.
  useLayoutEffect(() => {
    measure();
  });

  return {
    gridRef,
    windowRef,
    scrollerRef,
    measured,
    cols,
    gap: m.gap,
    tileWidth,
    itemHeight: itemPx,
    rowHeight,
    sectionHeaderHeight: headerHeight,
    totalHeight,
    sectionRows,
    atTop: m.viewTop < rowHeight,
    startRow,
    endRow,
    // Rendered tile range [startIndex, endIndex] (inclusive, may be empty).
    startIndex: startRow * cols,
    endIndex: Math.min(count - 1, (endRow + 1) * cols - 1),
    offsetY: geometryRowTop(geometry, startRow),
    // On-screen tile range, for the position label and the anchor.
    visibleStart: Math.min(Math.max(0, count - 1), firstVisibleRow * cols),
    visibleEnd: Math.min(count - 1, (lastVisibleRow + 1) * cols - 1),
    readAnchor,
    restoreAnchor,
    scrollToIndex,
    scrollToTop,
    setScrollTop,
    gridTop,
    measure,
  };
}
