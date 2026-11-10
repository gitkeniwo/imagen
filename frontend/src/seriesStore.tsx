import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type SeriesKind,
  type SeriesNode,
  type SeriesTree,
  seriesApi,
  type ThemeNode,
} from "./api";

// One shared copy of the theme → series tree (every row, archived included).
// App owns it so the composer, History, Library and the Series page agree on
// names and colors; anything that changes series calls `reload()`.

const RECENT_LIMIT = 4;
// series-v2 B3: one tree fetch per burst of finished generations.
const RELOAD_DEBOUNCE_MS = 400;
const recentKey = (libraryKey: string | null) => `imagen-series-recent:${libraryKey ?? "memory"}`;

export interface SeriesPath {
  id: number;
  name: string;
  color: string | null;
  theme: { id: number; name: string } | null;
  archived: boolean;
  cover_image_id: number | null;
}

export interface SeriesStore {
  tree: SeriesTree | null;
  loaded: boolean;
  /** Every leaf series, archived ones included. */
  leaves: SeriesNode[];
  themes: ThemeNode[];
  get: (id: number | null | undefined) => SeriesPath | null;
  node: (id: number | null | undefined) => SeriesNode | null;
  /** Refetch the tree (trailing debounce, ~400 ms, so a batch of finished
   *  generations refreshes once). `touched` = the series whose contents
   *  changed: their `versionOf` goes up after the fetch. Omitted = all of
   *  them; `[]` = names/counts only. */
  reload: (touched?: number[] | "all") => Promise<void>;
  /** Changes whenever this series' records may have changed (series-v2 B3);
   *  a series detail listens to its own id only. */
  versionOf: (id: number | null | undefined) => number;
  /** Recently picked series ids, newest first (live, unarchived only). */
  recent: number[];
  markRecent: (id: number) => void;
  create: (kind: SeriesKind, name: string, parentId?: number | null) => Promise<SeriesNode>;
  version: number;
}

const empty: SeriesStore = {
  tree: null,
  loaded: false,
  leaves: [],
  themes: [],
  get: () => null,
  node: () => null,
  reload: async () => {},
  versionOf: () => 0,
  recent: [],
  markRecent: () => {},
  create: async () => {
    throw new Error("series store unavailable");
  },
  version: 0,
};

const SeriesContext = createContext<SeriesStore>(empty);

export function useSeries(): SeriesStore {
  return useContext(SeriesContext);
}

export function SeriesContextProvider({
  value,
  children,
}: {
  value: SeriesStore;
  children: ReactNode;
}) {
  return <SeriesContext.Provider value={value}>{children}</SeriesContext.Provider>;
}

function readRecent(libraryKey: string | null): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(recentKey(libraryKey)) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((v): v is number => Number.isInteger(v) && v > 0).slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** App-level state behind `useSeries()`. Reloads when `refreshKey` changes. */
export function useSeriesState(libraryKey: string | null, refreshKey: unknown): SeriesStore {
  const [tree, setTree] = useState<SeriesTree | null>(null);
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<number[]>(() => readRecent(libraryKey));
  // Per-series change counters + one epoch for "everything changed".
  const [bumps, setBumps] = useState<Map<number, number>>(() => new Map());
  const [epoch, setEpoch] = useState(0);
  const pending = useRef<{
    all: boolean;
    ids: Set<number>;
    timer: number | undefined;
    waiters: (() => void)[];
  }>({ all: false, ids: new Set(), timer: undefined, waiters: [] });

  useEffect(() => setPicked(readRecent(libraryKey)), [libraryKey]);

  const flush = useCallback(() => {
    const batch = pending.current;
    pending.current = { all: false, ids: new Set(), timer: undefined, waiters: [] };
    const settle = () => {
      if (batch.all) setEpoch((e) => e + 1);
      else if (batch.ids.size) {
        setBumps((current) => {
          const next = new Map(current);
          for (const id of batch.ids) next.set(id, (next.get(id) ?? 0) + 1);
          return next;
        });
      }
      for (const done of batch.waiters) done();
    };
    seriesApi
      .tree("all")
      .then((next) => {
        setTree(next);
        setVersion((v) => v + 1);
      })
      .catch(() => {
        // Older backend or offline: the feature simply shows nothing.
        setTree((current) => current ?? { themes: [], unthemed: [] });
      })
      .finally(settle);
  }, []);

  const reload = useCallback(
    (touched: number[] | "all" = "all") =>
      new Promise<void>((resolve) => {
        const p = pending.current;
        if (touched === "all") p.all = true;
        else for (const id of touched) if (id) p.ids.add(id);
        p.waiters.push(resolve);
        window.clearTimeout(p.timer);
        p.timer = window.setTimeout(flush, RELOAD_DEBOUNCE_MS);
      }),
    [flush],
  );

  useEffect(() => () => window.clearTimeout(pending.current.timer), []);

  // Startup, a library switch or a data change: fetch now (menus and the
  // composer need the tree), taking any pending debounced call along.
  useEffect(() => {
    void reload("all");
    window.clearTimeout(pending.current.timer);
    flush();
  }, [reload, flush, refreshKey, libraryKey]);

  const versionOf = useCallback(
    (id: number | null | undefined) => (id ? bumps.get(id) ?? 0 : 0) + epoch,
    [bumps, epoch],
  );

  const { leaves, themes, byId, themeById } = useMemo(() => {
    const themes = tree?.themes ?? [];
    const leaves = [...themes.flatMap((theme) => theme.series), ...(tree?.unthemed ?? [])];
    const byId = new Map<number, SeriesNode>();
    for (const leaf of leaves) byId.set(leaf.id, leaf);
    const themeById = new Map<number, ThemeNode>();
    for (const theme of themes) themeById.set(theme.id, theme);
    return { leaves, themes, byId, themeById };
  }, [tree]);

  const get = useCallback(
    (id: number | null | undefined): SeriesPath | null => {
      if (!id) return null;
      const leaf = byId.get(id);
      if (!leaf) return null;
      const theme = leaf.parent_id ? themeById.get(leaf.parent_id) ?? null : null;
      return {
        id: leaf.id,
        name: leaf.name,
        color: leaf.color,
        theme: theme ? { id: theme.id, name: theme.name } : null,
        archived: !!leaf.archived || !!theme?.archived,
        cover_image_id: leaf.cover_image_id,
      };
    },
    [byId, themeById],
  );

  const node = useCallback((id: number | null | undefined) => (id ? byId.get(id) ?? null : null), [byId]);

  const markRecent = useCallback(
    (id: number) => {
      setPicked((current) => {
        const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
        try {
          localStorage.setItem(recentKey(libraryKey), JSON.stringify(next));
        } catch {
          /* private mode: memory only */
        }
        return next;
      });
    },
    [libraryKey],
  );

  // Picked first, then the most recently active, so a fresh device still
  // shows something useful.
  const recent = useMemo(() => {
    const live = (id: number) => {
      const path = get(id);
      return !!path && !path.archived;
    };
    const out = picked.filter(live);
    const byActivity = [...leaves]
      .filter((leaf) => live(leaf.id) && leaf.last_at)
      .sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
    for (const leaf of byActivity) {
      if (out.length >= RECENT_LIMIT) break;
      if (!out.includes(leaf.id)) out.push(leaf.id);
    }
    return out.slice(0, RECENT_LIMIT);
  }, [picked, leaves, get]);

  const create = useCallback(
    async (kind: SeriesKind, name: string, parentId: number | null = null) => {
      const created = await seriesApi.create({ kind, name, parentId });
      await reload([]);
      if (kind === "series") markRecent(created.id);
      return created;
    },
    [reload, markRecent],
  );

  return useMemo(
    () => ({
      tree,
      loaded: tree !== null,
      leaves,
      themes,
      get,
      node,
      reload,
      versionOf,
      recent,
      markRecent,
      create,
      version,
    }),
    [tree, leaves, themes, get, node, reload, versionOf, recent, markRecent, create, version],
  );
}

/** "Theme / Series" as one line, for titles and tooltips. */
export function seriesPathText(path: SeriesPath | null, noTheme: string): string {
  if (!path) return "";
  return `${path.theme?.name ?? noTheme} / ${path.name}`;
}
