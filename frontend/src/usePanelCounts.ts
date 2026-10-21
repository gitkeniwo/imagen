import { useEffect, useState } from "react";
import { api } from "./api";

export interface PanelCounts {
  library?: number;
  history?: number;
  favorites?: number;
  drafts?: number;
  bin?: number;
}

// Item totals for the panel tabs. Each list endpoint already returns `total`,
// so a limit=1 page is enough; a failed request just leaves that count blank.
export function usePanelCounts(refreshKey: string): PanelCounts {
  const [counts, setCounts] = useState<PanelCounts>({});

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.listImages({ limit: 1 }),
      api.listGenerations({ limit: 1 }),
      api.listGenerations({ limit: 1, starred: true }),
      api.listDrafts({ limit: 1 }),
      api.listBin({ limit: 1 }),
    ]).then(([library, history, favorites, drafts, bin]) => {
      if (cancelled) return;
      const total = (r: PromiseSettledResult<{ total: number }>) =>
        r.status === "fulfilled" ? r.value.total : undefined;
      setCounts({
        library: total(library),
        history: total(history),
        favorites: total(favorites),
        drafts: total(drafts),
        bin: total(bin),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return counts;
}
