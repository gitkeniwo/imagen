import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefreshResult } from "./useChunkedList";
import type { GridAnchor } from "./useVirtualGrid";

interface AnchoredData<T> {
  ready: boolean;
  total: number;
  version: number;
  get: (index: number) => T | undefined;
  indexOf: (id: number, hint?: number) => number;
  idsInRange: (start: number, end: number) => Promise<number[]>;
  refresh: <Captured>(
    range: [number, number],
    beforeSwap: (totals: { oldTotal: number; newTotal: number }) => Captured,
  ) => Promise<RefreshResult<Captured> | null>;
}

interface AnchoredGrid {
  measured: boolean;
  atTop: boolean;
  rowHeight: number;
  startIndex: number;
  endIndex: number;
  visibleStart: number;
  readAnchor: () => GridAnchor | null;
  restoreAnchor: (anchor: GridAnchor) => void;
  scrollToTop: (smooth?: boolean) => void;
  scrollToIndex: (index: number, align?: "start" | "nearest" | "center") => void;
}

interface Options<T> {
  data: AnchoredData<T>;
  grid: AnchoredGrid;
  idOf: (row: T) => number;
  filtersKey: string;
  refreshKey: number;
  // Remember the first visible row across remounts (tab switches).
  storageKey?: string;
  // Called after every refresh attempt, including a failed one. The timeline
  // uses this as its tick.
  onRefreshDone?: () => void;
}

function readSaved(key: string): { filtersKey: string; id: number; index: number } | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Refresh a sparse virtual list without moving the row the user is reading.
 *
 * The anchor is found again by id after the swap, not by offset: records may
 * be inserted above the viewport, deleted, or moved by a timestamp edit. New
 * rows above a scrolled-away viewport produce the `↑ N new` badge; at the top
 * they simply appear. A filter change resets the list to the top.
 */
export function useAnchoredRefresh<T>({
  data,
  grid,
  idOf,
  filtersKey,
  refreshKey,
  storageKey,
  onRefreshDone,
}: Options<T>) {
  const [newCount, setNewCount] = useState(0);
  const pendingAnchor = useRef<{
    anchor: GridAnchor | null;
    anchorId: number | null;
    topId: number | null;
    atTop: boolean;
    delta: number;
  } | null>(null);
  const refreshing = useRef(false);
  // A refresh asked for while one runs: run once more afterwards.
  const queued = useRef(false);
  const rangeRef = useRef<[number, number]>([grid.startIndex, grid.endIndex]);
  rangeRef.current = [grid.startIndex, grid.endIndex];
  const onRefreshDoneRef = useRef(onRefreshDone);
  onRefreshDoneRef.current = onRefreshDone;

  const refresh = async (): Promise<void> => {
    if (refreshing.current) {
      queued.current = true;
      return;
    }
    refreshing.current = true;
    try {
      // The anchor is staged inside `beforeSwap`, i.e. before the fresh rows
      // and their version bump exist, so the layout effect below always
      // finds it on the commit that shows them.
      await data.refresh(rangeRef.current, ({ oldTotal, newTotal }) => {
        const anchor = grid.readAnchor();
        const anchorRow = anchor ? data.get(anchor.index) : undefined;
        const topRow = data.get(0);
        pendingAnchor.current = {
          anchor,
          anchorId: anchorRow ? idOf(anchorRow) : null,
          topId: topRow ? idOf(topRow) : null,
          // "Near the top" = less than one row scrolled.
          atTop: !anchor || (anchor.index === 0 && anchor.offset > -grid.rowHeight),
          delta: newTotal - oldTotal,
        };
      });
    } finally {
      refreshing.current = false;
      onRefreshDoneRef.current?.();
    }
    if (queued.current) {
      queued.current = false;
      // Let the layout effect apply this result before the next one starts.
      window.setTimeout(() => void refreshRef.current(), 0);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Runs after the refreshed rows are on screen, before paint.
  useLayoutEffect(() => {
    const pending = pendingAnchor.current;
    if (!pending) return;
    pendingAnchor.current = null;
    const { anchor, anchorId, topId, atTop, delta } = pending;
    let fresh = 0;
    if (topId !== null) {
      // Count rows that now sit before the old first row. This works for id
      // order and for created_at / updated_at order alike.
      const at = data.indexOf(topId, 0);
      fresh = at >= 0 ? at : Math.max(0, delta);
    } else {
      fresh = Math.max(0, delta);
    }
    if (!anchor || atTop) return; // at the top: new rows simply appear
    let index = anchorId !== null ? data.indexOf(anchorId, anchor.index + fresh) : -1;
    if (index < 0) index = Math.max(0, anchor.index + fresh);
    grid.restoreAnchor({ index, offset: anchor.offset });
    // Deletes and restores only re-anchor; the badge is for new rows.
    if (fresh > 0) setNewCount((n) => n + fresh);
  }, [data.version]);

  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    void refreshRef.current();
  }, [refreshKey]);

  // Back at the top by any means: the badge has done its job.
  useEffect(() => {
    if (grid.atTop && newCount > 0) setNewCount(0);
  }, [grid.atTop, newCount]);

  // New filters: start over at the top.
  const firstFilters = useRef(true);
  useEffect(() => {
    if (firstFilters.current) {
      firstFilters.current = false;
      return;
    }
    setNewCount(0);
    grid.scrollToTop();
  }, [filtersKey]);

  // Remember the first visible row; restore it by id when this list is
  // mounted again with the same filters.
  const restored = useRef(false);
  useEffect(() => {
    if (!storageKey || !restored.current || !data.ready) return;
    const row = data.get(grid.visibleStart);
    if (!row) return;
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          filtersKey,
          id: idOf(row),
          index: grid.visibleStart,
        }),
      );
    } catch {
      /* storage unavailable: nothing to restore later */
    }
  }, [data.version, grid.visibleStart, storageKey, filtersKey]);

  useEffect(() => {
    if (restored.current || !data.ready || !grid.measured) return;
    restored.current = true;
    const saved = storageKey ? readSaved(storageKey) : null;
    if (!saved || saved.filtersKey !== filtersKey || saved.index <= 0) return;
    const from = Math.max(0, saved.index - 500);
    const to = Math.min(data.total - 1, from + 999);
    if (to < from) return;
    void data
      .idsInRange(from, to)
      .then((ids) => {
        const at = ids.indexOf(saved.id);
        if (at >= 0) grid.scrollToIndex(from + at, "start");
      })
      .catch(() => {});
  }, [data.ready, grid.measured]);

  const clearNew = () => setNewCount(0);
  return { refresh, newCount, clearNew };
}
