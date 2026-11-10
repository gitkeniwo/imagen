import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer } from "react";
import { api, type ImageSeriesEntry } from "./api";

// series-v2 B1a: what the series badge, info card and menus need from App,
// plus a shared cache of "which series does this image belong to".

export interface SeriesNav {
  /** Show the series detail (closes the viewer and the fullscreen manager). */
  openSeries: (id: number) => void;
  /** Bind the composer to this series (App's existing behaviour). */
  openInWorkspace: (id: number) => void;
  /** Data changed (series moved/removed): refresh every panel. */
  onChanged: () => void;
  /** Changes when the library or the series tree changes; keys the cache. */
  epoch: string;
}

const noop = () => {};
const SeriesNavContext = createContext<SeriesNav>({
  openSeries: noop,
  openInWorkspace: noop,
  onChanged: noop,
  epoch: "",
});

export function SeriesNavProvider({ value, children }: { value: SeriesNav; children: ReactNode }) {
  return <SeriesNavContext.Provider value={value}>{children}</SeriesNavContext.Provider>;
}

export function useSeriesNav(): SeriesNav {
  return useContext(SeriesNavContext);
}

// --- image → series cache --------------------------------------------------
// Image ids restart in every library, so the cache is dropped whenever the
// epoch (library key + series tree version) changes.

const BATCH = 200;
let epochNow = "";
let cacheRevision = 0;
const cache = new Map<number, ImageSeriesEntry[]>();
const pending = new Set<number>();
const inflight = new Set<number>();
const listeners = new Set<() => void>();
let timer: number | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function setEpoch(epoch: string) {
  if (epoch === epochNow) return;
  epochNow = epoch;
  cacheRevision++;
  cache.clear();
  pending.clear();
  inflight.clear();
  notify();
}

/** Drop the image → series cache after a mark/cover change. */
export function invalidateImageSeriesCache() {
  cacheRevision++;
  cache.clear();
  pending.clear();
  inflight.clear();
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  notify();
}

function flush() {
  timer = null;
  const ids = [...pending];
  pending.clear();
  const epoch = epochNow;
  const revision = cacheRevision;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    for (const id of chunk) inflight.add(id);
    api
      .imageSeries(chunk)
      .then(({ items }) => {
        if (epoch !== epochNow || revision !== cacheRevision) return;
        for (const item of items) cache.set(item.imageId, item.series);
      })
      .catch(() => {
        if (epoch !== epochNow || revision !== cacheRevision) return;
        // Older backend: treat as "no series" instead of retrying forever.
        for (const id of chunk) if (!cache.has(id)) cache.set(id, []);
      })
      .finally(() => {
        if (epoch !== epochNow || revision !== cacheRevision) return;
        for (const id of chunk) inflight.delete(id);
        notify();
      });
  }
}

function request(ids: number[]) {
  let added = false;
  for (const id of ids) {
    if (id > 0 && !cache.has(id) && !inflight.has(id) && !pending.has(id)) {
      pending.add(id);
      added = true;
    }
  }
  if (added && timer === null) timer = window.setTimeout(flush, 30);
}

/**
 * Series of each image (primary first). Returns a lookup; `undefined` means
 * still loading. Fetches only ids not cached for the current epoch.
 */
export function useImageSeries(ids: number[]): (id: number) => ImageSeriesEntry[] | undefined {
  const { epoch } = useSeriesNav();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  setEpoch(epoch);
  const key = ids.join(",");
  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);
  useEffect(() => {
    if (key) request(key.split(",").map(Number));
  }, [key, epoch, cacheRevision]);
  return useMemo(
    () => (id: number) => cache.get(id),
    [epoch, key, cacheRevision], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** One-off read through the same cache (for menus opened on demand). */
export async function fetchImageSeries(id: number): Promise<ImageSeriesEntry[]> {
  const hit = cache.get(id);
  if (hit) return hit;
  const revision = cacheRevision;
  try {
    const { items } = await api.imageSeries([id]);
    const series = items[0]?.series ?? [];
    if (revision === cacheRevision) cache.set(id, series);
    return series;
  } catch {
    return [];
  }
}
