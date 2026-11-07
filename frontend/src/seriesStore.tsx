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
const recentKey = (libraryKey: string | null) => `imagen-series-recent:${libraryKey ?? "memory"}`;

export interface SeriesPath {
  id: number;
  name: string;
  color: string | null;
  theme: { id: number; name: string } | null;
  archived: boolean;
}

export interface SeriesStore {
  tree: SeriesTree | null;
  loaded: boolean;
  /** Every leaf series, archived ones included. */
  leaves: SeriesNode[];
  themes: ThemeNode[];
  get: (id: number | null | undefined) => SeriesPath | null;
  node: (id: number | null | undefined) => SeriesNode | null;
  reload: () => Promise<void>;
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
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => setPicked(readRecent(libraryKey)), [libraryKey]);

  const reload = useCallback(async () => {
    const run = seriesApi
      .tree("all")
      .then((next) => {
        setTree(next);
        setVersion((v) => v + 1);
      })
      .catch(() => {
        // Older backend or offline: the feature simply shows nothing.
        setTree((current) => current ?? { themes: [], unthemed: [] });
      });
    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey, libraryKey]);

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
      await reload();
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
      recent,
      markRecent,
      create,
      version,
    }),
    [tree, leaves, themes, get, node, reload, recent, markRecent, create, version],
  );
}

/** "Theme / Series" as one line, for titles and tooltips. */
export function seriesPathText(path: SeriesPath | null, noTheme: string): string {
  if (!path) return "";
  return `${path.theme?.name ?? noTheme} / ${path.name}`;
}
