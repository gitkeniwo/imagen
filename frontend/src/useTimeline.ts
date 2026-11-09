import { useEffect, useRef, useState } from "react";
import type { ImageTimeline } from "./api";
import { buildTimeline, type Timeline } from "./timeline";

/**
 * Load the per-day timeline used by the position line, scrubber and jump
 * dialog. `tick` lets a page refresh it alongside the list without making
 * `refreshKey` a second dependency (which used to fetch it twice).
 */
export function useTimeline(
  fetcher: () => Promise<ImageTimeline>,
  filtersKey: string,
  tick: number,
) {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetcherRef
      .current()
      .then((result) => {
        if (!alive) return;
        setTimeline(buildTimeline(result));
        setError(null);
      })
      .catch((reason) => {
        if (!alive) return;
        setError((reason as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filtersKey, tick]);

  return { timeline, loading, error };
}
