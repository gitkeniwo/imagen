import { useCallback, useEffect, useRef, useState } from "react";

/** Rows per request. Lists ask for chunks near the viewport only. */
export const CHUNK = 120;
/** Chunks kept on each side of the viewport; farther ones (except 0) are dropped. */
const KEEP_CHUNKS = 6;

export interface ListPage<T> {
  rows: T[];
  total: number;
}

interface Chunk<T> {
  rows: T[];
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

interface Options<T> {
  // Changing this drops every cached row and starts again at the top.
  key: string;
  fetchChunk: (offset: number, limit: number, signal?: AbortSignal) => Promise<ListPage<T>>;
  idOf: (row: T) => number;
  // Ids only, same filters and order as fetchChunk (ranges / select-all).
  fetchIds?: (offset: number, limit: number, signal?: AbortSignal) => Promise<number[]>;
  onRows?: (rows: T[]) => void;
}

/**
 * A result list as sparse fixed-size chunks.
 *
 * Nothing accumulates from the top: `ensure(start, end)` fetches only the
 * chunks covering that range, requests that fall out of it are aborted, and
 * chunks far from it are evicted. A change of `key` drops everything;
 * `refresh()` keeps the cache (marked stale) and refetches chunk 0 plus the
 * chunks currently on screen, so the caller can keep its scroll anchor.
 */
export function useChunkedList<T>({
  key,
  fetchChunk,
  idOf,
  fetchIds,
  onRows,
}: Options<T>) {
  const chunks = useRef(new Map<number, Chunk<T>>());
  const inflight = useRef(new Map<number, AbortController>());
  // Bumped on every reset: answers from an older epoch are ignored.
  const epoch = useRef(0);
  // Bumped whenever `refresh()` swaps in fresh rows. A chunk request started
  // before the swap carries offsets from before it (new rows shift every
  // position), so its answer is dropped instead of cached as fresh.
  const refreshGen = useRef(0);
  const fetchChunkRef = useRef(fetchChunk);
  fetchChunkRef.current = fetchChunk;
  const fetchIdsRef = useRef(fetchIds);
  fetchIdsRef.current = fetchIds;
  const idOfRef = useRef(idOf);
  idOfRef.current = idOf;
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

  const fetchChunkAt = useCallback(async (index: number, signal?: AbortSignal) => {
    const r = await fetchChunkRef.current(index * CHUNK, CHUNK, signal);
    onRowsRef.current?.(r.rows);
    return r;
  }, []);

  // Chunk 0 is never evicted: its first row is how a refresh distinguishes
  // new rows above the viewport from everything else, and it is the
  // scroll-to-top target.
  const evict = useCallback((first: number, last: number) => {
    for (const chunk of chunks.current.keys()) {
      if (chunk === 0) continue;
      if (chunk < first - KEEP_CHUNKS || chunk > last + KEEP_CHUNKS) {
        chunks.current.delete(chunk);
      }
    }
  }, []);

  /** Make sure the chunks covering [start, end] (inclusive indexes) are loaded. */
  const ensure = useCallback(
    (start: number, end: number) => {
      lastRange.current = [start, end];
      const n = totalRef.current;
      if (n === 0) return;
      const first = Math.max(0, Math.floor(start / CHUNK));
      const last = Math.min(
        Math.floor((n - 1) / CHUNK),
        Math.floor(Math.max(start, end) / CHUNK),
      );
      // Requests nobody is looking at any more are cancelled.
      for (const [chunk, ctrl] of inflight.current) {
        if (chunk < first - 1 || chunk > last + 1) {
          ctrl.abort();
          inflight.current.delete(chunk);
        }
      }
      evict(first, last);
      const myEpoch = epoch.current;
      const myGen = refreshGen.current;
      // Middle chunk first: the range includes overscan on both sides, and
      // the on-screen part should arrive before the margins.
      const mid = Math.floor(
        (Math.floor(start / CHUNK) + Math.floor(end / CHUNK)) / 2,
      );
      const order = Array.from({ length: last - first + 1 }, (_, k) => first + k).sort(
        (a, b) => Math.abs(a - mid) - Math.abs(b - mid),
      );
      for (const index of order) {
        const have = chunks.current.get(index);
        if ((have && !have.stale) || inflight.current.has(index)) continue;
        const ctrl = new AbortController();
        inflight.current.set(index, ctrl);
        fetchChunkAt(index, ctrl.signal)
          .then((r) => {
            if (epoch.current !== myEpoch || refreshGen.current !== myGen) return;
            chunks.current.set(index, { rows: r.rows, stale: false });
            if (r.total !== totalRef.current) applyTotal(r.total);
            setError(null);
            bump();
          })
          .catch((e) => {
            if (
              (e as Error).name === "AbortError" ||
              epoch.current !== myEpoch ||
              refreshGen.current !== myGen
            ) {
              return;
            }
            setError((e as Error).message);
          })
          .finally(() => {
            if (inflight.current.get(index) === ctrl) inflight.current.delete(index);
          });
      }
    },
    [applyTotal, bump, evict, fetchChunkAt],
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
    fetchChunkAt(0)
      .then((r) => {
        if (epoch.current !== myEpoch) return;
        chunks.current.set(0, { rows: r.rows, stale: false });
        applyTotal(r.total);
        setReady(true);
        bump();
      })
      .catch((e) => {
        if (epoch.current !== myEpoch) return;
        setError((e as Error).message);
        setReady(true);
      });
  }, [applyTotal, bump, fetchChunkAt]);

  useEffect(() => {
    reset();
    return () => {
      epoch.current += 1;
      abortAll();
    };
  }, [key, reset]);

  /**
   * Soft refresh after a change (generation finished, star, delete …).
   * Every cached chunk turns stale; chunk 0 and the chunks of `range` (the
   * viewport) are refetched together and swapped in at once, so the caller
   * re-anchors against fresh data in a single commit.
   */
  const refresh = useCallback(
    async <Captured,>(
      range: [number, number],
      // Called synchronously right before the swap (and the re-render it
      // triggers): the caller reads its anchor against the old rows and
      // stages whatever its layout effect needs for the new ones.
      beforeSwap: (totals: { oldTotal: number; newTotal: number }) => Captured,
    ): Promise<RefreshResult<Captured> | null> => {
      const myEpoch = epoch.current;
      const oldTotal = totalRef.current;
      const wanted = new Set<number>([0]);
      if (oldTotal > 0) {
        // Rows may have been added above the viewport: look one chunk further
        // down too, so the shifted anchor is very likely among fresh rows.
        const lastChunk = Math.floor((range[1] + CHUNK) / CHUNK);
        for (let index = Math.floor(range[0] / CHUNK); index <= lastChunk; index++) {
          wanted.add(index);
        }
      }
      try {
        const results = await Promise.all(
          [...wanted].map(async (index) => [index, await fetchChunkAt(index)] as const),
        );
        if (epoch.current !== myEpoch) return null;
        const newTotal = results.find(([index]) => index === 0)![1].total;
        const captured = beforeSwap({ oldTotal, newTotal });
        // Anything still in flight was asked for against the old positions:
        // cancel it and forget it, so `ensure` below may ask again.
        refreshGen.current += 1;
        abortAll();
        for (const chunk of chunks.current.values()) chunk.stale = true;
        for (const [index, r] of results) {
          if (r.rows.length > 0) {
            chunks.current.set(index, { rows: r.rows, stale: false });
          } else {
            chunks.current.delete(index);
          }
        }
        // A stale chunk past the new end would only draw rows that are gone.
        const lastIndex = Math.max(0, Math.ceil(newTotal / CHUNK) - 1);
        for (const chunk of chunks.current.keys()) {
          if (chunk > lastIndex) chunks.current.delete(chunk);
        }
        applyTotal(newTotal);
        setError(null);
        bump();
        // Refill whatever the cancelled requests were for (and any stale
        // chunk in the last requested range) right away; nothing else would
        // ask again until the next scroll.
        ensure(lastRange.current[0], lastRange.current[1]);
        return { oldTotal, newTotal, captured };
      } catch (e) {
        if (epoch.current === myEpoch) setError((e as Error).message);
        return null;
      }
    },
    [applyTotal, bump, ensure, fetchChunkAt],
  );

  const get = useCallback(
    (index: number): T | undefined =>
      chunks.current.get(Math.floor(index / CHUNK))?.rows[index % CHUNK],
    [],
  );

  /** The loaded chunk containing `index` (for the viewer's initial list). */
  const chunkAt = useCallback((index: number) => {
    const chunk = Math.floor(index / CHUNK);
    const rows = chunks.current.get(chunk);
    return rows ? { offset: chunk * CHUNK, rows: rows.rows } : null;
  }, []);

  /** Position of `id` among loaded rows, preferring the search near `hint`. */
  const indexOf = useCallback(
    (id: number, hint = 0): number => {
      const ordered = [...chunks.current.entries()].sort(
        ([a], [b]) => Math.abs(a * CHUNK - hint) - Math.abs(b * CHUNK - hint),
      );
      for (const [chunk, entry] of ordered) {
        const at = entry.rows.findIndex((row) => idOfRef.current(row) === id);
        if (at >= 0) return chunk * CHUNK + at;
      }
      return -1;
    },
    [],
  );

  /**
   * Ids for [start, end] (inclusive). Uses loaded, fresh chunks when they
   * cover the whole range, otherwise one ids request.
   */
  const idsInRange = useCallback(
    async (start: number, end: number): Promise<number[]> => {
      const ids: number[] = [];
      for (let index = start; index <= end; index++) {
        const chunk = chunks.current.get(Math.floor(index / CHUNK));
        const row = chunk && !chunk.stale ? chunk.rows[index % CHUNK] : undefined;
        if (!row) {
          if (!fetchIdsRef.current) {
            throw new Error("This list does not provide id ranges.");
          }
          return fetchIdsRef.current(start, end - start + 1);
        }
        ids.push(idOfRef.current(row));
      }
      return ids;
    },
    [],
  );

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
