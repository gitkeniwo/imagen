import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ImageRow, type LibraryFilters } from "./api";

/** Rows per request. The grid asks for chunks near the viewport only. */
export const CHUNK = 120;
/** Chunks kept on each side of the viewport; farther ones (except 0) are dropped. */
const KEEP_CHUNKS = 6;

interface Chunk {
  rows: ImageRow[];
  // Marked after a refresh: still drawn (so nothing flashes), but refetched
  // as soon as it is asked for again.
  stale: boolean;
}

export interface RefreshResult<T> {
  oldTotal: number;
  newTotal: number;
  // Whatever `beforeSwap` returned, read just before fresh rows replaced the
  // old ones (the caller's scroll anchor, taken against the old data).
  captured: T;
}

/**
 * The Library result as a sparse list of fixed-size chunks.
 *
 * Nothing accumulates from the top: `ensure(start, end)` fetches only the
 * chunks covering that range, requests that fall out of it are aborted, and
 * chunks far from it are evicted. A change of `filtersKey` drops everything;
 * `refresh()` keeps the cache (marked stale) and refetches chunk 0 plus the
 * chunks currently on screen, so the caller can keep its scroll anchor.
 */
export function useChunkedImages(
  filters: LibraryFilters,
  filtersKey: string,
  onRows?: (rows: ImageRow[]) => void,
) {
  const chunks = useRef(new Map<number, Chunk>());
  const inflight = useRef(new Map<number, AbortController>());
  // Bumped on every reset: answers from an older epoch are ignored.
  const epoch = useRef(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;
  const lastRange = useRef<[number, number]>([0, 0]);
  const [total, setTotal] = useState(0);
  const totalRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-render trigger; the data itself lives in the ref.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const applyTotal = useCallback((n: number) => {
    totalRef.current = n;
    setTotal(n);
  }, []);

  const fetchChunk = useCallback(
    async (index: number, signal?: AbortSignal) => {
      const r = await api.listImages(
        { ...filtersRef.current, offset: index * CHUNK, limit: CHUNK },
        signal,
      );
      onRowsRef.current?.(r.images);
      return r;
    },
    [],
  );

  // Chunk 0 is never evicted: its first id is how a refresh tells new
  // images (above it) from everything else, and it is the scroll-to-top target.
  const evict = useCallback((first: number, last: number) => {
    for (const key of chunks.current.keys()) {
      if (key === 0) continue;
      if (key < first - KEEP_CHUNKS || key > last + KEEP_CHUNKS) chunks.current.delete(key);
    }
  }, []);

  /** Make sure the chunks covering [start, end] (inclusive indexes) are loaded. */
  const ensure = useCallback(
    (start: number, end: number) => {
      lastRange.current = [start, end];
      const n = totalRef.current;
      if (n === 0) return;
      const first = Math.max(0, Math.floor(start / CHUNK));
      const last = Math.min(Math.floor((n - 1) / CHUNK), Math.floor(Math.max(start, end) / CHUNK));
      // Requests nobody is looking at any more are cancelled.
      for (const [key, ctrl] of inflight.current) {
        if (key < first - 1 || key > last + 1) {
          ctrl.abort();
          inflight.current.delete(key);
        }
      }
      evict(first, last);
      const myEpoch = epoch.current;
      // Middle chunk first: the range includes overscan on both sides, and
      // the on-screen part should arrive before the margins.
      const mid = Math.floor((Math.floor(start / CHUNK) + Math.floor(end / CHUNK)) / 2);
      const order = Array.from({ length: last - first + 1 }, (_, k) => first + k).sort(
        (a, b) => Math.abs(a - mid) - Math.abs(b - mid),
      );
      for (const i of order) {
        const have = chunks.current.get(i);
        if ((have && !have.stale) || inflight.current.has(i)) continue;
        const ctrl = new AbortController();
        inflight.current.set(i, ctrl);
        fetchChunk(i, ctrl.signal)
          .then((r) => {
            if (epoch.current !== myEpoch) return;
            chunks.current.set(i, { rows: r.images, stale: false });
            if (r.total !== totalRef.current) applyTotal(r.total);
            setError(null);
            bump();
          })
          .catch((e) => {
            if ((e as Error).name === "AbortError" || epoch.current !== myEpoch) return;
            setError((e as Error).message);
          })
          .finally(() => {
            if (inflight.current.get(i) === ctrl) inflight.current.delete(i);
          });
      }
    },
    [applyTotal, bump, evict, fetchChunk],
  );

  const abortAll = () => {
    for (const ctrl of inflight.current.values()) ctrl.abort();
    inflight.current.clear();
  };

  /** Drop everything and load chunk 0 (filters changed, or a retry). */
  const reset = useCallback(() => {
    epoch.current += 1;
    const myEpoch = epoch.current;
    abortAll();
    chunks.current = new Map();
    setReady(false);
    setError(null);
    fetchChunk(0)
      .then((r) => {
        if (epoch.current !== myEpoch) return;
        chunks.current.set(0, { rows: r.images, stale: false });
        applyTotal(r.total);
        setReady(true);
        bump();
      })
      .catch((e) => {
        if (epoch.current !== myEpoch) return;
        setError((e as Error).message);
        setReady(true);
      });
  }, [applyTotal, bump, fetchChunk]);

  useEffect(() => {
    reset();
    return () => {
      epoch.current += 1;
      abortAll();
    };
  }, [filtersKey, reset]);

  /**
   * Soft refresh after a change (generation finished, star, delete …).
   * Every cached chunk turns stale; chunk 0 and the chunks of `range` (the
   * viewport) are refetched together and swapped in at once, so the caller
   * re-anchors against fresh data in a single commit.
   */
  const refresh = useCallback(
    async <T,>(range: [number, number], beforeSwap: () => T): Promise<RefreshResult<T> | null> => {
      const myEpoch = epoch.current;
      const oldTotal = totalRef.current;
      const wanted = new Set<number>([0]);
      if (oldTotal > 0) {
        // Rows may have been added above the viewport: look one chunk further
        // down too, so the shifted anchor is very likely among fresh rows.
        const lastChunk = Math.floor((range[1] + CHUNK) / CHUNK);
        for (let i = Math.floor(range[0] / CHUNK); i <= lastChunk; i++) wanted.add(i);
      }
      try {
        const results = await Promise.all(
          [...wanted].map(async (i) => [i, await fetchChunk(i)] as const),
        );
        if (epoch.current !== myEpoch) return null;
        const newTotal = results.find(([i]) => i === 0)![1].total;
        const captured = beforeSwap();
        for (const chunk of chunks.current.values()) chunk.stale = true;
        for (const [i, r] of results) {
          if (r.images.length > 0) chunks.current.set(i, { rows: r.images, stale: false });
          else chunks.current.delete(i);
        }
        // A stale chunk past the new end would only draw rows that are gone.
        const lastIndex = Math.max(0, Math.ceil(newTotal / CHUNK) - 1);
        for (const key of chunks.current.keys()) if (key > lastIndex) chunks.current.delete(key);
        applyTotal(newTotal);
        setError(null);
        bump();
        return { oldTotal, newTotal, captured };
      } catch (e) {
        if (epoch.current === myEpoch) setError((e as Error).message);
        return null;
      }
    },
    [applyTotal, bump, fetchChunk],
  );

  const get = useCallback(
    (index: number): ImageRow | undefined =>
      chunks.current.get(Math.floor(index / CHUNK))?.rows[index % CHUNK],
    [],
  );

  /** The loaded chunk containing `index` (for the viewer's initial list). */
  const chunkAt = useCallback((index: number) => {
    const c = Math.floor(index / CHUNK);
    const chunk = chunks.current.get(c);
    return chunk ? { offset: c * CHUNK, rows: chunk.rows } : null;
  }, []);

  /** Position of `id` among loaded rows, preferring the search near `hint`. */
  const indexOf = useCallback((id: number, hint = 0): number => {
    const ordered = [...chunks.current.entries()].sort(
      ([a], [b]) => Math.abs(a * CHUNK - hint) - Math.abs(b * CHUNK - hint),
    );
    for (const [c, chunk] of ordered) {
      const at = chunk.rows.findIndex((row) => row.id === id);
      if (at >= 0) return c * CHUNK + at;
    }
    return -1;
  }, []);

  /**
   * Ids for [start, end] (inclusive). Uses loaded, fresh chunks when they
   * cover the whole range, otherwise one `/api/images/ids` request.
   */
  const idsInRange = useCallback(async (start: number, end: number): Promise<number[]> => {
    const ids: number[] = [];
    for (let i = start; i <= end; i++) {
      const chunk = chunks.current.get(Math.floor(i / CHUNK));
      const row = chunk && !chunk.stale ? chunk.rows[i % CHUNK] : undefined;
      if (!row) {
        const r = await api.listImageIds({
          ...filtersRef.current,
          offset: start,
          limit: end - start + 1,
        });
        return r.ids;
      }
      ids.push(row.id);
    }
    return ids;
  }, []);

  return {
    total,
    ready,
    error,
    version,
    get,
    chunkAt,
    indexOf,
    ensure,
    refresh,
    reset,
    idsInRange,
  };
}
