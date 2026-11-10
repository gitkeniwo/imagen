import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ImageRow,
  imgThumbUrl,
  providerOf,
  type SeriesDetail as SeriesDetailRow,
  type SeriesGeneration,
  type SeriesMark,
  type SeriesOrder,
  type SeriesRecordFilter,
  type SeriesReorderResult,
  type SeriesVersion,
  type SeriesVersionAttempt,
  seriesApi,
} from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import { cardTime, clockTime, dayKey, fullTime, parseTime } from "../historyTime";
import { generationRuntime } from "../generationMetrics";
import { changedParams, compactEqual, diffWords, type ParamKey, samePrompt, splitTrailingSpace } from "../promptDiff";
import { useProviders } from "../useProviders";
import { invalidateImageSeriesCache } from "../seriesContext";
import { useSeries } from "../seriesStore";
import {
  currentRuns,
  type GroupTag,
  groupTags,
  type PlannedMove,
  placeAt,
  regroupVersions,
  runsOf,
  stepMove,
  withOrder,
} from "../seriesOrder";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { Switch } from "./ComposerControls";
import { SeriesDot, successRate } from "./SeriesBits";
import { MoveToThemeDialog, SeriesEditDialog } from "./SeriesDialogs";
import SeriesMovePicker from "./SeriesMovePicker";
import SeriesMarkButtons from "./SeriesMarks";
import { HiddenVersionRow, VersionGroup, VersionSkeleton } from "./SeriesVersionGroup";
import { type DropHit, useReorderDrag } from "./useReorderDrag";
import { Button, IconButton } from "./ui/Button";
import Icon from "./ui/Icon";
import Menu, { type MenuItem } from "./ui/Menu";
import Segmented from "./ui/Segmented";

const PAGE = 30;
// series-v2 B3: versions per chunk of the Changes view (whole versions only).
const VERSION_PAGE = 15;
// The backend's page limits, for refreshing everything already loaded.
const MAX_ROWS = 200;
const MAX_VERSIONS = 100;
const DETAIL_VIEW_KEY = "imagen-series-detail-view";
// series-v2 B4: how long renumber hints stay, and the Undo windows.
const HINT_MS = 2500;
const MOVE_UNDO_MS = 6000;
const RESET_UNDO_MS = 10_000;
type DetailView = "changes" | "attempts";

function initialDetailView(): DetailView {
  try {
    return localStorage.getItem(DETAIL_VIEW_KEY) === "attempts" ? "attempts" : "changes";
  } catch {
    return "changes";
  }
}

/** The nearest scrolling ancestor (`overflowing` = only one that scrolls now). */
function scrollParent(el: HTMLElement | null, overflowing = true): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && (!overflowing || node.scrollHeight > node.clientHeight)) {
      return node;
    }
  }
  return null;
}

/** Calls `onHit` when `el` comes within 300 px of the visible area. */
function useNearEnd(el: HTMLElement | null, enabled: boolean, onHit: () => void) {
  const hit = useRef(onHit);
  hit.current = onHit;
  useEffect(() => {
    if (!el || !enabled) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) hit.current();
      },
      { root: scrollParent(el, false), rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, enabled]);
}

/** A version attempt as an Attempts-view row (they share everything else
 *  with the version), so the expanded group can reuse `TimelineRow`. */
function attemptRow(v: SeriesVersion, a: SeriesVersionAttempt, seriesId: number): SeriesGeneration {
  return {
    id: a.id,
    seq: a.seq,
    prompt: v.prompt,
    provider: a.provider,
    model: v.params.model ?? "",
    aspect_ratio: v.params.aspect_ratio,
    resolution: v.params.resolution,
    status: a.status,
    error_message: a.error_message,
    raw_finish: a.raw_finish,
    output_image_id: a.output_image_id,
    created_at: a.created_at,
    source: a.source,
    client_task_id: null,
    marker_color: a.marker_color,
    duration_ms: a.duration_ms,
    attempts: a.attempts,
    series_id: seriesId,
    mark: a.mark,
    inputs: v.inputs,
    outputImage: a.outputImage,
    // Inside a version every earlier attempt has the same configuration.
    previous:
      a.seq > v.first_seq
        ? {
            id: 0,
            seq: a.seq - 1,
            prompt: v.prompt,
            provider: a.provider,
            model: v.params.model ?? "",
            aspect_ratio: v.params.aspect_ratio,
            resolution: v.params.resolution,
            status: a.status,
            input_ids: v.params.input_ids,
          }
        : null,
  };
}
const COVER_HEIGHT = 170;
const PICK_HEIGHT = 90;
const OUTPUT_WIDTH = 88;
const COMPACT_COVER_HEIGHT = 140;
const COMPACT_PICK_HEIGHT = 64;
const COMPACT_OUTPUT_WIDTH = 56;
/** Below this width the detail switches to the compact (phone) timeline. */
const COMPACT_BELOW = 640;

/** Width of the element itself, so the layout follows the sidebar panel's
 *  size rather than the device. */
function useNarrow(el: HTMLElement | null, below: number) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const check = () => setNarrow(el.getBoundingClientRect().width < below);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, below]);
  return narrow;
}

const ratioOf = (img: Pick<ImageRow, "width" | "height">) =>
  img.width > 0 && img.height > 0 ? img.width / img.height : 1;

export default function SeriesDetail({
  id,
  onBack,
  phone = false,
  boundTo = [],
  onOpenViewer,
  onReuse,
  onRerun,
  onOpenInWorkspace,
}: {
  id: number;
  onBack: () => void;
  phone?: boolean;
  /** Workspace numbers bound to this series. */
  boundTo?: number[];
  onOpenViewer: (img: ImageRow, list: ImageRow[]) => void;
  onReuse: (g: SeriesGeneration) => void;
  onRerun?: (g: SeriesGeneration) => void;
  onOpenInWorkspace: (id: number) => void;
}) {
  const { t, lang, reason } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();
  const store = useSeries();
  const { isReady } = useProviders();
  const [detail, setDetail] = useState<SeriesDetailRow | null>(null);
  const [rows, setRows] = useState<SeriesGeneration[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({
    all: 0, success: 0, blocked: 0, error: 0, picks: 0, rejects: 0,
  });
  const [filter, setFilter] = useState<SeriesRecordFilter | "all">("all");
  const [showChanges, setShowChanges] = useState(true);
  const [view, setView] = useState<DetailView>(initialDetailView);
  const [versions, setVersions] = useState<SeriesVersion[]>([]);
  const [versionCursor, setVersionCursor] = useState<number | null>(null);
  const [versionTotal, setVersionTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [endEl, setEndEl] = useState<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"rename" | "move" | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const compact = useNarrow(rootEl, COMPACT_BELOW) || phone;
  // series-v2 B4: the whole order (version boundaries beyond loaded pages),
  // selection mode, records waiting for the server and renumber hints.
  const [order, setOrder] = useState<SeriesOrder | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const selAnchor = useRef<number | null>(null);
  const [pending, setPending] = useState<Set<number>>(() => new Set());
  const [hints, setHints] = useState<{ was: Map<number, number>; tags: Map<number, GroupTag> }>(() => ({
    was: new Map(),
    tags: new Map(),
  }));
  const hintTimer = useRef(0);
  const [picker, setPicker] = useState<{ ids: number[]; side: "before" | "after"; rect: DOMRect | null } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(DETAIL_VIEW_KEY, view);
    } catch {
      /* memory only */
    }
  }, [view]);

  const status = filter === "all" ? undefined : filter;
  // Sizes already loaded, so a refresh keeps them (read through a ref: a
  // refresh must not depend on them).
  const loaded = useRef({ rows: 0, versions: 0 });
  loaded.current = { rows: rows.length, versions: versions.length };
  const loadToken = useRef(0);

  /** Header, counts and the current view from the top. `keep` = refresh what
   *  is loaded (a finished generation) instead of starting over. */
  const load = useCallback(
    async (keep: boolean) => {
      const token = ++loadToken.current;
      if (!keep) setLoading(true);
      setError(null);
      try {
        const rowLimit = keep ? Math.min(MAX_ROWS, Math.max(PAGE, loaded.current.rows)) : PAGE;
        const versionLimit = keep
          ? Math.min(MAX_VERSIONS, Math.max(VERSION_PAGE, loaded.current.versions))
          : VERSION_PAGE;
        const [d, tl, vs, om] = await Promise.all([
          seriesApi.get(id),
          // The Changes view only needs the filter counts from here.
          seriesApi.timeline(id, { status, limit: view === "attempts" ? rowLimit : 1 }),
          // The Attempts view only needs the version count from here.
          seriesApi.versions(id, { status, limit: view === "changes" ? versionLimit : 1 }),
          seriesApi.order(id),
        ]);
        if (token !== loadToken.current) return;
        setDetail(d);
        setOrder(om);
        setCounts(tl.counts);
        setTotal(tl.total);
        setVersionTotal(vs.total);
        if (view === "attempts") {
          setRows(tl.generations);
        } else {
          setVersions(vs.versions);
          setVersionCursor(vs.next_cursor);
        }
      } catch (e) {
        if (token === loadToken.current) setError((e as Error).message);
      } finally {
        if (token === loadToken.current) setLoading(false);
      }
    },
    [id, status, view],
  );

  /** Next chunk: whole versions (Changes) or the next rows (Attempts). */
  const loadMore = useCallback(async () => {
    if (loadingMore || loading) return;
    const token = loadToken.current;
    setLoadingMore(true);
    try {
      if (view === "changes") {
        if (versionCursor === null) return;
        const vs = await seriesApi.versions(id, { status, cursor: versionCursor, limit: VERSION_PAGE });
        if (token !== loadToken.current) return;
        setVersions((current) => [...current, ...vs.versions.filter((v) => !current.some((c) => c.version === v.version))]);
        setVersionCursor(vs.next_cursor);
      } else {
        if (rows.length >= total) return;
        const tl = await seriesApi.timeline(id, { status, limit: PAGE, offset: rows.length });
        if (token !== loadToken.current) return;
        setRows((current) => [...current, ...tl.generations.filter((g) => !current.some((c) => c.id === g.id))]);
        setTotal(tl.total);
      }
    } catch (e) {
      if (token === loadToken.current) toast(t("load_error", { msg: (e as Error).message }), "error");
    } finally {
      setLoadingMore(false);
    }
  }, [id, status, view, versionCursor, rows.length, total, loading, loadingMore, toast, t]);

  // Selection belongs to one series.
  useEffect(() => {
    setSelecting(false);
    setSelected(new Set());
    setPicker(null);
  }, [id]);

  // A new series, filter or view starts from the top.
  useEffect(() => {
    setRows([]);
    setVersions([]);
    setVersionCursor(null);
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, filter, view]);

  // Filters scroll back to the top of the list (the toolbar stays in view).
  const barRef = useRef<HTMLDivElement>(null);
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    const bar = barRef.current;
    const scroller = scrollParent(bar);
    if (!bar || !scroller) return;
    const offset = bar.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (offset < 0) scroller.scrollTop += offset - 8;
  }, [filter]);

  // Only this series' changes refresh it (series-v2 B3): finished
  // generations elsewhere leave it alone.
  const seriesVersion = store.versionOf(id);
  const firstVersion = useRef(seriesVersion);
  useEffect(() => {
    if (seriesVersion === firstVersion.current) return;
    firstVersion.current = seriesVersion;
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesVersion]);

  const hasMore = view === "changes" ? versionCursor !== null : rows.length < total;
  useNearEnd(endEl, hasMore && !loading && !loadingMore && !error, () => void loadMore());

  // --- series-v2 B4: custom order ------------------------------------------

  const runs = useMemo(() => (order ? currentRuns(order) : []), [order]);
  const versionIds = useMemo(() => new Map(runs.map((r) => [r.version, r.ids])), [runs]);
  const orderIds = useMemo(() => (order ? order.items.map((it) => it.id) : []), [order]);
  const orderCustom = order?.order_custom ?? false;

  const showHints = (changed: SeriesReorderResult["changed"], tags: Map<number, GroupTag>) => {
    const was = new Map<number, number>();
    for (const c of changed) if (c.old_seq !== null) was.set(c.id, c.old_seq);
    window.clearTimeout(hintTimer.current);
    setHints({ was, tags });
    hintTimer.current = window.setTimeout(() => setHints({ was: new Map(), tags: new Map() }), HINT_MS);
  };
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);

  /** Order changed on the server: this view, and everyone showing #N. */
  const afterOrderChange = async () => {
    await load(true);
    void store.reload([]);
  };

  const restore = async (ids: number[], announce: boolean) => {
    try {
      await seriesApi.reorderRestore(id, ids);
      if (announce) toast(t("sv4_restored_toast"), "info");
      await afterOrderChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  /** Optimistic: the list changes first, the server follows; a failure
   *  puts everything back. */
  const commitMove = async (move: PlannedMove) => {
    if (!order) return;
    const prev = { order, versions, rows };
    const kOf = new Map(order.items.map((it) => [it.id, it.k]));
    const before = currentRuns(order);
    const after = runsOf(move.order, (x) => kOf.get(x) ?? -1);
    const seqOf = new Map(move.order.map((x, i) => [x, i + 1]));
    if (view === "changes") {
      const next =
        status === "pick" || status === "reject"
          ? null
          : regroupVersions(order, move.order, versions, status, samePrompt);
      if (next) setVersions(next);
      else setPending(new Set(move.ids));
    } else {
      setRows((rs) => rs.map((r) => ({ ...r, seq: seqOf.get(r.id) ?? r.seq })).sort((a, b) => b.seq - a.seq));
    }
    setOrder(withOrder(order, move.order));
    try {
      const res = await seriesApi.reorder(id, { generationIds: move.ids, ...move.placement });
      showHints(res.changed, groupTags(before, after, move.ids));
      const previous = prev.order.items.map((it) => it.id);
      toast(t("sv4_moved_toast", { n: move.ids.length }), "info", {
        durationMs: MOVE_UNDO_MS,
        action: { label: t("undo"), onClick: () => void restore(previous, false) },
      });
      await afterOrderChange();
    } catch (e) {
      setOrder(prev.order);
      setVersions(prev.versions);
      setRows(prev.rows);
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    } finally {
      setPending(new Set());
    }
  };

  /** Back to time order at once; Undo (10 s) restores the custom order. */
  const resetOrder = async () => {
    try {
      const res = await seriesApi.reorderReset(id);
      const previous = res.previous_order ?? [];
      showHints(res.changed, new Map());
      toast(t("sv4_reset_toast"), "info", {
        durationMs: RESET_UNDO_MS,
        action: { label: t("undo"), onClick: () => void restore(previous, true) },
      });
      await afterOrderChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  /** Where a record is on screen (the picker opens next to it). */
  const rectOf = (gid: number): DOMRect | null => {
    let best: DOMRect | null = null;
    for (const el of rootEl?.querySelectorAll<HTMLElement>("[data-drop-ids]") ?? []) {
      if (!(el.dataset.dropIds ?? "").split(",").includes(String(gid))) continue;
      const r = el.getBoundingClientRect();
      if (r.height && (!best || r.height < best.height)) best = r;
    }
    return best;
  };

  /** Move up / down / before… / after… for these records. "Up" is up on
   *  screen: the detail lists newest first, so it is later in the order. */
  const moveItems = (ids: number[]): MenuItem[] => {
    if (!order || !ids.length || !ids.every((x) => order.items.some((it) => it.id === x))) return [];
    const up = stepMove(order, ids, "later");
    const down = stepMove(order, ids, "earlier");
    return [
      { label: t("sv4_move_up"), icon: "moveUp", hint: compact ? undefined : "⌥↑", disabled: !up, onSelect: () => up && void commitMove(up) },
      { label: t("sv4_move_down"), icon: "moveDown", hint: compact ? undefined : "⌥↓", disabled: !down, onSelect: () => down && void commitMove(down) },
      { label: t("sv4_move_before"), icon: "reorder", onSelect: () => setPicker({ ids, side: "before", rect: rectOf(ids[0]) }) },
      { label: t("sv4_move_after"), icon: "reorder", onSelect: () => setPicker({ ids, side: "after", rect: rectOf(ids[0]) }) },
    ];
  };

  const toggleIds = (ids: number[], e: ReactMouseEvent) => {
    const all = orderIds;
    setSelected((cur) => {
      const next = new Set(cur);
      if (e.shiftKey && ids.length === 1 && selAnchor.current !== null) {
        // Shift: a range in series order.
        const a = all.indexOf(selAnchor.current);
        const b = all.indexOf(ids[0]);
        if (a >= 0 && b >= 0) {
          for (const x of all.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
          return next;
        }
      }
      const on = ids.every((x) => cur.has(x));
      for (const x of ids) {
        if (on) next.delete(x);
        else next.add(x);
      }
      return next;
    });
    if (ids.length === 1) selAnchor.current = ids[0];
  };
  const startSelecting = (gid: number, e: ReactMouseEvent) => {
    setSelecting(true);
    toggleIds([gid], e);
  };
  const exitSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    selAnchor.current = null;
  };

  // Thumbnails for the lifted stack.
  const thumbOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const v of versions) for (const a of v.attempts) if (a.outputImage && !a.outputImage.deleted_at) m.set(a.id, imgThumbUrl(a.outputImage));
    for (const r of rows) if (r.outputImage && !r.outputImage.deleted_at) m.set(r.id, imgThumbUrl(r.outputImage));
    return m;
  }, [versions, rows]);

  const dropMove = (ids: number[], hit: DropHit) =>
    placeAt(orderIds, ids, hit.anchor, hit.above ? "after" : "before");
  const { drag, start: startDrag } = useReorderDrag({
    root: rootEl,
    enabled: !phone && !!order,
    canDrop: (ids, hit) => !!dropMove(ids, hit),
    onDrop: (ids, hit) => {
      const m = dropMove(ids, hit);
      if (m) void commitMove(m);
    },
  });
  /** Drag these, or the whole selection when they are part of it. */
  const gripFor = (ids: number[]) =>
    phone
      ? undefined
      : (e: ReactPointerEvent) => {
          const source = selecting && ids.some((x) => selected.has(x)) ? orderIds.filter((x) => selected.has(x)) : ids;
          startDrag(e, { ids: source, thumbs: source.map((x) => thumbOf.get(x)).filter((u): u is string => !!u).slice(0, 2) });
        };
  const dim = drag ? drag.ids : pending;

  // Keyboard: ⌥↑ / ⌥↓ move the selection (or the focused row / version);
  // Esc leaves selection mode.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (!rootEl?.isConnected || picker || document.querySelector(".menu, .modal, .sheet")) return;
    if (e.key === "Escape" && selecting) {
      exitSelecting();
      return;
    }
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || !order) return;
    let ids = orderIds.filter((x) => selected.has(x));
    if (!ids.length) {
      const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-drop-ids]");
      if (!el || !rootEl.contains(el)) return;
      ids = (el.dataset.dropIds ?? "").split(",").map(Number).filter((n) => n > 0);
    }
    if (!ids.length) return;
    e.preventDefault();
    const m = stepMove(order, ids, e.key === "ArrowUp" ? "later" : "earlier");
    if (m) void commitMove(m);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const refreshAfterChange = async () => {
    await Promise.all([load(true), store.reload([id])]);
  };

  const setMark = async (imageId: number, kind: SeriesMark | null) => {
    try {
      await seriesApi.setMark(id, imageId, kind);
      invalidateImageSeriesCache();
      await refreshAfterChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const setCover = async (imageId: number | null) => {
    try {
      await seriesApi.update(id, { coverImageId: imageId });
      await refreshAfterChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const clearPicks = async () => {
    if (!detail || detail.picks === 0) return;
    const ok = await askConfirm({
      title: t("sv6_clear_picks_title", { n: detail.picks }),
      message: t("sv6_clear_picks_body"),
      confirmLabel: t("sv6_clear_picks_confirm"),
    });
    if (!ok) return;
    try {
      const res = await seriesApi.clearPicks(id);
      invalidateImageSeriesCache();
      toast(t("sv6_cleared_toast", { n: res.cleared }), "info");
      await refreshAfterChange();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const archive = async (archived: boolean) => {
    try {
      await seriesApi.update(id, { archived });
      await store.reload([id]);
      toast(archived ? t("series_archived_toast") : t("series_unarchived_toast"));
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const remove = async () => {
    if (!detail) return;
    const ok = await askConfirm({
      title: t("series_delete_title"),
      message: t("series_delete_message", { name: detail.name, n: detail.records }),
      confirmLabel: t("delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await seriesApi.remove(id);
      await store.reload([id]);
      onBack();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }), "error");
    }
  };

  const outputs = useMemo(() => (detail?.outputs ?? []).map((o) => o.image), [detail]);
  const orderByImage = useMemo(() => {
    const map = new Map<number, { seq: number; version: number }>();
    for (const item of order?.items ?? []) {
      if (!item.output_image_id) continue;
      const current = map.get(item.output_image_id);
      if (!current || item.seq > current.seq) {
        map.set(item.output_image_id, { seq: item.seq, version: item.version });
      }
    }
    return map;
  }, [order]);
  const cover = detail?.cover_image ?? outputs[outputs.length - 1] ?? null;
  const coverSeq = cover ? orderByImage.get(cover.id)?.seq ?? null : null;
  const picked = useMemo(
    () =>
      outputs
        .filter((img) => img.mark === "pick")
        .sort((a, b) => (orderByImage.get(a.id)?.seq ?? 0) - (orderByImage.get(b.id)?.seq ?? 0)),
    [outputs, orderByImage],
  );
  const recentSuccesses = useMemo(
    () => outputs.filter((img) => img.mark !== "reject").slice(-6).reverse(),
    [outputs],
  );
  const topImages = picked.length ? picked : recentSuccesses;

  if (!detail) {
    return (
      <div className="series-detail" ref={setRootEl}>
        <div className="panel muted">
          {error ? (
            <div className="load-error">
              <span className="small">{t("load_error", { msg: error })}</span>
              <button onClick={() => void load(false)}>{t("retry")}</button>
            </div>
          ) : (
            <>
              <span className="spinner" /> {t("loading")}
            </>
          )}
        </div>
      </div>
    );
  }

  // The oldest record, once everything is loaded (either view).
  const oldestOf = () => {
    if (view === "attempts") {
      return rows.length === total && rows.length ? rows[rows.length - 1].created_at : null;
    }
    if (versionCursor !== null || !versions.length) return null;
    return versions[versions.length - 1].attempts.reduce<string | null>(
      (min, a) => (min === null || a.created_at < min ? a.created_at : min),
      null,
    );
  };
  const first = parseTime(oldestOf());
  const now = new Date();
  const spanFrom = detail.records > 0 && filter === "all" && first ? first : null;
  const last = parseTime(detail.last_at);
  const rate = successRate(detail);
  const statLine = [
    t("series_tries_n", { n: detail.tries }),
    t("series_success_n", { n: detail.success }),
    t("series_blocked_n", { n: detail.blocked }),
    t("series_error_n", { n: detail.error }),
    detail.aborted > 0 ? t("series_cancelled_n", { n: detail.aborted }) : null,
    rate !== null && compact ? t("series_rate", { n: rate }) : null,
    last
      ? spanFrom && dayKey(spanFrom) !== dayKey(last)
        ? `${cardTime(spanFrom, now, lang)} – ${cardTime(last, now, lang)}`
        : cardTime(last, now, lang)
      : null,
    boundTo.length ? t("series_bound_to", { n: boundTo.join(", "), count: boundTo.length }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const moreItems: MenuItem[] = [
    ...(compact
      ? [
          { label: t("series_open_in_workspace"), icon: "reuse" as const, onSelect: () => onOpenInWorkspace(id) },
          { label: t("series_rename"), icon: "edit" as const, onSelect: () => setDialog("rename") },
          { label: t("series_move_to_theme"), icon: "moveToTheme" as const, onSelect: () => setDialog("move") },
        ]
      : []),
    ...(detail.records > 0 && !selecting
      ? [{ label: t("sv4_select"), icon: "selectMode" as const, onSelect: () => setSelecting(true) }]
      : []),
    ...(compact && orderCustom
      ? [{ label: t("sv4_reset_order"), icon: "restore" as const, onSelect: () => void resetOrder() }]
      : []),
    ...(detail.picks > 0
      ? [{
          label: t("sv6_clear_picks"),
          icon: "remove" as const,
          hint: detail.picks,
          onSelect: () => void clearPicks(),
        }]
      : []),
    detail.archived
      ? { label: t("series_unarchive"), icon: "unarchive", onSelect: () => void archive(false) }
      : { label: t("series_archive"), icon: "archive", onSelect: () => void archive(true) },
    { label: t("series_delete"), icon: "delete", danger: true, onSelect: () => void remove() },
  ];

  const timeTexts = (iso: string) => {
    const d = parseTime(iso);
    if (!d) return { short: "", full: "" };
    return {
      short: dayKey(d) === dayKey(now) ? clockTime(d, lang) : `${cardTime(d, now, lang)} ${clockTime(d, lang)}`,
      full: fullTime(d, lang),
    };
  };

  /** One Attempts-view row; inside a version (`v`) it also says "First try of vK". */
  const attemptItem = (g: SeriesGeneration, v?: SeriesVersion) => {
    const when = timeTexts(g.created_at);
    return (
      <TimelineRow
        key={g.id}
        g={g}
        compact={compact}
        showChanges={v ? true : showChanges}
        firstOf={v && g.seq === v.first_seq ? v.version : undefined}
        isCover={!!g.output_image_id && g.output_image_id === detail.cover_image_id}
        onOpen={(img) => onOpenViewer(img, outputs.length ? outputs : [img])}
        onReuse={() => onReuse(g)}
        onRerun={onRerun && g.source !== "manual" && isReady(providerOf(g)) ? () => onRerun(g) : undefined}
        onMark={
          g.outputImage && !g.outputImage.deleted_at
            ? (kind) => void setMark(g.outputImage!.id, kind)
            : undefined
        }
        onCover={
          g.outputImage && !g.outputImage.deleted_at
            ? () => void setCover(detail.cover_image_id === g.outputImage!.id ? null : g.outputImage!.id)
            : undefined
        }
        reasonText={reason(g.raw_finish, providerOf(g)) || g.error_message || t("no_output")}
        timeText={when.short}
        fullTimeText={when.full}
        reorder={{
          selecting,
          selected: selected.has(g.id),
          onToggle: (e) => toggleIds([g.id], e),
          onGrip: gripFor([g.id]),
          dim: dim.has(g.id),
          was: hints.was.get(g.id),
          moveItems: moveItems([g.id]),
        }}
      />
    );
  };

  /** ⋯ of a version: acts on its latest attempt (same configuration). */
  const versionMenu = (v: SeriesVersion): MenuItem[] => {
    const latest = v.attempts[v.attempts.length - 1];
    if (!latest) return [];
    const g = attemptRow(v, latest, id);
    const image = latest.outputImage && !latest.outputImage.deleted_at ? latest.outputImage : null;
    return [
      ...moveItems(versionIds.get(v.version) ?? []),
      ...(image
        ? [
            {
              label: latest.mark === "pick" ? t("sv6_clear_pick") : t("sv6_pick"),
              icon: "favorite" as const,
              onSelect: () => void setMark(image.id, latest.mark === "pick" ? null : "pick"),
            },
            {
              label: latest.mark === "reject" ? t("sv6_clear_reject") : t("sv6_reject"),
              icon: "close" as const,
              onSelect: () => void setMark(image.id, latest.mark === "reject" ? null : "reject"),
            },
            {
              label: detail.cover_image_id === image.id ? t("sv6_clear_cover") : t("sv6_set_cover"),
              icon: "cover" as const,
              disabled: latest.mark === "reject",
              onSelect: () => void setCover(detail.cover_image_id === image.id ? null : image.id),
            },
          ]
        : []),
      { label: t("reuse"), icon: "reuse", onSelect: () => onReuse(g) },
      ...(onRerun && g.source !== "manual" && isReady(providerOf(g))
        ? [{ label: t("rerun_short"), icon: "rerun" as const, onSelect: () => onRerun(g) }]
        : []),
      {
        label: t("sv2_copy_prompt"),
        icon: "copy",
        onSelect: async () => toast((await copyText(v.prompt)) ? t("copied") : t("copy_failed")),
      },
    ];
  };

  const filterOptions = [
    { value: "all" as const, label: `${t("filter_all")} ${counts.all}` },
    { value: "success" as const, label: `${t("hist_result_success")} ${counts.success}` },
    { value: "blocked" as const, label: `${t("hist_result_blocked")} ${counts.blocked}` },
    { value: "error" as const, label: `${t("hist_result_error")} ${counts.error}` },
    { value: "pick" as const, label: `${t("sv6_filter_picks")} ${counts.picks}` },
    { value: "reject" as const, label: `${t("sv6_filter_rejected")} ${counts.rejects}` },
  ];
  const coverLabel = (img: ImageRow) => {
    const pos = orderByImage.get(img.id);
    return pos ? t("sv6_cover_option", { n: pos.seq, k: pos.version }) : `#${img.id}`;
  };
  const coverChoices = (() => {
    const seen = new Set<number>();
    const out: ImageRow[] = [];
    for (const img of [cover, ...picked, ...recentSuccesses]) {
      if (!img || seen.has(img.id)) continue;
      seen.add(img.id);
      out.push(img);
    }
    return out.slice(0, 12);
  })();
  const coverItems: MenuItem[] = [
    ...(detail.cover_image_id !== null
      ? [{ label: t("sv6_auto_cover"), icon: "cover" as const, onSelect: () => void setCover(null) }]
      : []),
    ...coverChoices.map((img) => ({
      label: coverLabel(img),
      icon: "cover" as const,
      hint: detail.cover_image_id === img.id ? t("sv6_cover_current") : undefined,
      onSelect: () => void setCover(img.id),
    })),
  ];

  return (
    <div className={`series-detail${compact ? " compact" : ""}`} ref={setRootEl}>
      <header className="series-detail-head">
        {compact ? (
          <div className="series-detail-phonebar">
            <IconButton icon="prev" label={t("series_back")} onClick={onBack} />
            <SeriesDot color={detail.color} />
            <div className="series-detail-phonetitle">
              <span>{detail.theme?.name ?? t("series_no_theme")}</span>
              <h2>{detail.name}</h2>
            </div>
            {!!detail.archived && <span className="series-archived-flag">{t("series_archived")}</span>}
            <Menu
              items={moreItems}
              renderTrigger={({ open, toggle }) => (
                <IconButton icon="more" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
              )}
            />
          </div>
        ) : (
          <>
            <nav className="series-crumbs" aria-label={t("series_breadcrumb")}>
              <button type="button" onClick={onBack}>{t("tab_series")}</button>
              <span aria-hidden="true">/</span>
              <span>{detail.theme?.name ?? t("series_no_theme")}</span>
            </nav>
            <div className="series-detail-title">
              <SeriesDot color={detail.color} size="lg" />
              <h2>{detail.name}</h2>
              {!!detail.archived && <span className="series-archived-flag">{t("series_archived")}</span>}
              <div className="series-detail-actions">
                <Button size="sm" onClick={() => onOpenInWorkspace(id)}>{t("series_open_in_workspace")}</Button>
                <Button size="sm" onClick={() => setDialog("rename")}>{t("series_rename")}</Button>
                <Button size="sm" onClick={() => setDialog("move")}>{t("series_move_to_theme")}…</Button>
                <Menu
                  items={moreItems}
                  renderTrigger={({ open, toggle }) => (
                    <IconButton icon="more" variant="outline" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
                  )}
                />
              </div>
            </div>
          </>
        )}
        <p className="series-detail-stats">{statLine}</p>
      </header>

      {outputs.length > 0 && cover && (
        <section className={`series-outputs${compact ? " compact" : ""}`} aria-label={t("series_outputs")}>
          <figure className="series-cover">
            <div className="series-cover-frame">
              <button
                type="button"
                className="series-cover-img"
                style={{
                  height: compact ? COMPACT_COVER_HEIGHT : COVER_HEIGHT,
                  width: Math.round((compact ? COMPACT_COVER_HEIGHT : COVER_HEIGHT) * ratioOf(cover)),
                }}
                onClick={() => onOpenViewer(cover, outputs)}
                title={t("open_viewer")}
              >
                <img src={imgThumbUrl(cover)} alt="" draggable={false} />
              </button>
              <SeriesMarkButtons
                size="lg"
                mark={cover.mark ?? null}
                onMark={(kind) => void setMark(cover.id, kind)}
              />
              <Menu
                className="series-cover-change"
                items={coverItems}
                renderTrigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className="series-cover-change-btn"
                    aria-expanded={open}
                    onClick={toggle}
                  >
                    <Icon name="cover" size="sm" />
                    {t("sv6_change_cover")}
                  </button>
                )}
              />
            </div>
            <figcaption>
              {coverSeq ? t("sv6_cover_n", { n: coverSeq }) : t("sv6_cover")}
            </figcaption>
          </figure>
          <div className="series-picks">
            <div className="series-picks-strip">
              {topImages.map((img) => {
                const h = compact ? COMPACT_PICK_HEIGHT : PICK_HEIGHT;
                return (
                  <span key={img.id} className="series-pick-frame" style={{ height: h, width: Math.round(h * ratioOf(img)) }}>
                    <button
                      type="button"
                      className={`series-pick-item${img.mark === "reject" ? " rejected" : ""}`}
                      title={t("open_viewer")}
                      onClick={() => onOpenViewer(img, outputs)}
                    >
                      <img src={imgThumbUrl(img)} alt="" loading="lazy" draggable={false} />
                      {orderByImage.get(img.id) && (
                        <span className="series-pick-num">#{orderByImage.get(img.id)!.seq}</span>
                      )}
                    </button>
                    <SeriesMarkButtons
                      size="lg"
                      mark={img.mark ?? null}
                      onMark={(kind) => void setMark(img.id, kind)}
                    />
                  </span>
                );
              })}
            </div>
            {picked.length > 0 ? (
              <span className="series-picks-caption">
                <Icon name="favorite" size="sm" filled />
                {t("sv6_picks_in_order", { n: picked.length })}
              </span>
            ) : (
              <span className="series-picks-caption fallback">
                <Icon name="info" size="sm" />
                {t("sv6_no_picks")}
              </span>
            )}
          </div>
        </section>
      )}

      {/* series-v2 B3: Changes (versions) / Attempts (the timeline). */}
      <div className={`series-view-bar${compact ? " compact" : ""}`}>
        <Segmented
          className="series-view-seg"
          value={view}
          onChange={setView}
          options={[
            {
              value: "changes" as const,
              label: (
                <>
                  {t("sv2_view_changes")}
                  {versionTotal !== null && <span className="series-view-count">{versionTotal}</span>}
                </>
              ),
              title: t("sv2_view_changes"),
            },
            {
              value: "attempts" as const,
              label: (
                <>
                  {t("sv2_view_attempts")}
                  <span className="series-view-count">{counts.all}</span>
                </>
              ),
              title: t("sv2_view_attempts"),
            },
          ]}
        />
        {orderCustom ? (
          <span className="series-order custom">
            <span className="series-order-chip" title={t("series_newest_first")}>
              <Icon name="reorder" size="sm" />
              {t("sv4_custom_order")}
            </span>
            {!compact && (
              <button type="button" className="series-order-reset" onClick={() => void resetOrder()}>
                {t("sv4_reset_order")}
              </button>
            )}
          </span>
        ) : (
          !compact && <span className="series-order">{t("series_newest_first")}</span>
        )}
      </div>

      <div className="series-timeline-bar" ref={barRef}>
        {compact ? (
          <div className="series-filter-chips" role="group" aria-label={t("hist_filter_result")}>
            {filterOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`tag-chip${filter === o.value ? " on" : ""}`}
                aria-pressed={filter === o.value}
                onClick={() => setFilter(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <Segmented value={filter} onChange={setFilter} options={filterOptions} />
        )}
        <div className="spacer" />
        {view === "attempts" && (
          <Switch checked={showChanges} onChange={setShowChanges} label={t("series_show_changes")} />
        )}
      </div>

      {selecting && (
        <div className={`series-select-bar${compact ? " compact" : ""}`} role="toolbar" aria-label={t("sv4_select")}>
          <strong>{t("sv4_selected_n", { n: selected.size })}</strong>
          <span className="spacer" />
          <Menu
            items={moveItems(orderIds.filter((x) => selected.has(x)))}
            renderTrigger={({ open, toggle }) => (
              <button
                type="button"
                className="series-select-btn"
                aria-expanded={open}
                disabled={selected.size === 0}
                onClick={toggle}
              >
                <Icon name="reorder" size="sm" />
                {t("sv4_move_to")}
              </button>
            )}
          />
          <button type="button" className="series-select-btn" onClick={exitSelecting}>
            {t("cancel")}
          </button>
        </div>
      )}

      {view === "changes" ? (
        loading && versions.length === 0 ? (
          <ol className="series-versions"><VersionSkeleton /></ol>
        ) : versions.length === 0 ? (
          <div className="series-empty">{detail.records === 0 ? t("series_detail_empty") : t("no_results")}</div>
        ) : (
          <ol className="series-versions" aria-label={t("sv2_view_changes")}>
            {versions.map((v) =>
              v.hidden ? (
                <HiddenVersionRow key={v.version} v={v} ids={versionIds.get(v.version)} />
              ) : (
                <VersionGroup
                  key={v.version}
                  v={v}
                  compact={compact}
                  filtered={filter !== "all"}
                  onOpen={(img) => onOpenViewer(img, outputs.length ? outputs : [img])}
                  reasonOf={(a) => reason(a.raw_finish, a.provider) || a.error_message || t("no_output")}
                  menu={versionMenu(v)}
                  onMark={(imageId, kind) => void setMark(imageId, kind)}
                  reorder={{
                    ids: versionIds.get(v.version) ?? v.attempts.map((a) => a.id),
                    selecting,
                    selected,
                    onToggle: toggleIds,
                    onModClick: startSelecting,
                    onGrip: gripFor(versionIds.get(v.version) ?? v.attempts.map((a) => a.id)),
                    dim,
                    was: hints.was,
                    tag: hints.tags.get(v.version) ?? null,
                  }}
                  renderAttempts={() => (
                    <ol className="series-timeline in-version" aria-label={t("series_attempts")}>
                      {[...v.attempts].reverse().map((a) => attemptItem(attemptRow(v, a, id), v))}
                    </ol>
                  )}
                />
              ),
            )}
            {loadingMore && <VersionSkeleton />}
          </ol>
        )
      ) : loading && rows.length === 0 ? (
        <div className="panel muted"><span className="spinner" /> {t("loading")}</div>
      ) : rows.length === 0 ? (
        <div className="series-empty">{detail.records === 0 ? t("series_detail_empty") : t("no_results")}</div>
      ) : (
        <ol className="series-timeline" aria-label={t("series_attempts")}>
          {rows.map((g) => attemptItem(g))}
        </ol>
      )}
      {view === "attempts" && loadingMore && (
        <div className="series-more"><span className="spinner" /></div>
      )}
      <div ref={setEndEl} className="series-end" aria-hidden="true" />

      {picker && order && (
        <SeriesMovePicker
          order={order}
          moving={picker.ids}
          side={picker.side}
          anchorRect={picker.rect}
          phone={phone}
          onClose={() => setPicker(null)}
          onPick={(anchor) => {
            const m = placeAt(orderIds, picker.ids, anchor, picker.side);
            setPicker(null);
            if (m) void commitMove(m);
          }}
        />
      )}
      {drag &&
        createPortal(
          <>
            {drag.zoneRect && (
              <div className="series-drag-zone" style={drag.zoneRect}>
                <Icon name={drag.zone === "up" ? "chevronUp" : "chevronDown"} size="sm" />
                {drag.zone === "up" ? t("sv4_scrolling_up") : t("sv4_scrolling_down")}
              </div>
            )}
            {drag.line && <div className="series-drop-line" style={drag.line} />}
            <div className="series-drag-stack" style={{ left: drag.x + 14, top: drag.y + 10 }}>
              {drag.thumbs.map((src) => (
                <img key={src} src={src} alt="" />
              ))}
              <strong>{t("sv2_n_attempts", { n: drag.ids.size })}</strong>
              <span className="series-drag-count">{drag.ids.size}</span>
            </div>
          </>,
          document.body,
        )}

      {dialog === "rename" && (
        <SeriesEditDialog
          mode="edit"
          id={id}
          initialName={detail.name}
          initialColor={detail.color}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "move" && (
        <MoveToThemeDialog id={id} current={detail.parent_id} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

const PARAM_ORDER: ParamKey[] = ["provider", "model", "resolution", "aspect_ratio", "inputs"];

function TimelineRow({
  g,
  compact,
  showChanges,
  firstOf,
  isCover,
  onOpen,
  onReuse,
  onRerun,
  onMark,
  onCover,
  reasonText,
  timeText,
  fullTimeText,
  reorder,
}: {
  g: SeriesGeneration;
  compact: boolean;
  showChanges: boolean;
  /** First attempt of version K (inside an expanded version group). */
  firstOf?: number;
  isCover: boolean;
  onOpen: (img: ImageRow) => void;
  onReuse: () => void;
  onRerun?: () => void;
  onMark?: (kind: SeriesMark | null) => void;
  onCover?: () => void;
  reasonText: string;
  timeText: string;
  fullTimeText: string;
  /** series-v2 B4: grip, checkbox, move menu, renumber hint. */
  reorder?: {
    selecting: boolean;
    selected: boolean;
    onToggle: (e: ReactMouseEvent) => void;
    onGrip?: (e: ReactPointerEvent) => void;
    dim: boolean;
    was?: number;
    moveItems: MenuItem[];
  };
}) {
  const { t } = useI18n();
  const { spec } = useProviders();
  const status = g.status === "aborted" ? "aborted" : g.status;
  const output = g.outputImage && !g.outputImage.deleted_at ? g.outputImage : null;
  const inputs = g.inputs ?? [];
  const runtime = generationRuntime(g.duration_ms, g.attempts, t);
  const prev = g.previous;
  const same = !!prev && samePrompt(prev.prompt, g.prompt);
  const changed = showChanges
    ? changedParams(prev, {
        provider: providerOf(g),
        model: g.model,
        aspect_ratio: g.aspect_ratio,
        resolution: g.resolution,
        input_ids: inputs.map((im) => im.id),
      })
    : new Set<ParamKey>();
  const modelLabel = (spec(providerOf(g), g.model)?.label ?? g.model)
    .replace(/\s*\(.*\)$/, "")
    .replace(/^Nano Banana (?=\S)/, "");
  const paramText: Record<ParamKey, string | null> = {
    provider: t(`provider_short_${providerOf(g)}`),
    model: modelLabel,
    resolution: g.resolution,
    aspect_ratio: g.aspect_ratio,
    inputs: null,
  };
  const params = PARAM_ORDER.filter((k) => paramText[k]);

  const actions: MenuItem[] = [
    { label: t("reuse"), icon: "reuse", onSelect: onReuse },
    ...(onRerun ? [{ label: t("rerun_short"), icon: "rerun" as const, onSelect: onRerun }] : []),
  ];
  const markActions: MenuItem[] = output
    ? [
        ...(onMark
          ? [
              {
                label: g.mark === "pick" ? t("sv6_clear_pick") : t("sv6_pick"),
                icon: "favorite" as const,
                onSelect: () => onMark(g.mark === "pick" ? null : "pick"),
              },
              {
                label: g.mark === "reject" ? t("sv6_clear_reject") : t("sv6_reject"),
                icon: "close" as const,
                onSelect: () => onMark(g.mark === "reject" ? null : "reject"),
              },
            ]
          : []),
        ...(onCover
          ? [{
              label: isCover ? t("sv6_clear_cover") : t("sv6_set_cover"),
              icon: "cover" as const,
              disabled: g.mark === "reject",
              onSelect: onCover,
            }]
          : []),
      ]
    : [];

  const prompt =
    firstOf !== undefined ? (
      <p className="series-same">{t("sv2_first_try_of", { k: firstOf })}</p>
    ) : showChanges && same ? (
      <p className="series-same">{t("series_same_prompt", { n: prev!.seq })}</p>
    ) : showChanges && prev ? (
      <p className="series-prompt">
        {(compact ? compactEqual(diffWords(prev.prompt, g.prompt)) : diffWords(prev.prompt, g.prompt)).map((seg, i) => {
          if (seg.kind === "equal") return <span key={i}>{seg.text}</span>;
          const [body, tail] = splitTrailingSpace(seg.text);
          return (
            <span key={i}>
              {seg.kind === "insert" ? <ins>{body}</ins> : <del>{body}</del>}
              {tail}
            </span>
          );
        })}
      </p>
    ) : (
      <p className="series-prompt">{g.prompt || <span className="muted">{t("series_no_prompt")}</span>}</p>
    );

  const media = output ? (
    <span className={`series-row-output-wrap${g.mark === "reject" ? " rejected" : ""}`}>
      <button
        type="button"
        className="series-row-output"
        style={{ aspectRatio: `${output.width} / ${output.height}` }}
        onClick={() => onOpen(output)}
        title={t("open_viewer")}
      >
        <img src={imgThumbUrl(output)} alt="" loading="lazy" draggable={false} />
      </button>
      {onMark && (
        <SeriesMarkButtons mark={g.mark ?? null} onMark={onMark} />
      )}
    </span>
  ) : g.status === "running" ? (
    <div className="series-row-fail running"><span className="spinner" /></div>
  ) : g.status === "success" ? (
    // A success whose output was deleted afterwards is not a failure.
    <div className="series-row-fail deleted" title={t("series_output_deleted")}>
      <Icon name="imageMissing" size="sm" />
      {!compact && <span>{t("series_output_deleted")}</span>}
    </div>
  ) : (
    <div className={`series-row-fail ${status === "blocked" ? "blocked" : "error"}`} title={reasonText}>
      {compact ? <Icon name={status === "blocked" ? "shield" : "warning"} size="sm" /> : <span>{reasonText}</span>}
    </div>
  );
  const failed = !output && g.status !== "success" && g.status !== "running";
  const mediaBox = (
    <div className="series-row-media" style={{ width: compact ? COMPACT_OUTPUT_WIDTH : OUTPUT_WIDTH }}>{media}</div>
  );

  const was = reorder?.was;
  const wasTag = was !== undefined ? <span className="series-was">{t("sv4_was_n", { n: was })}</span> : null;
  const moves = reorder?.moveItems ?? [];
  const rowCls = [
    "series-row",
    compact && "compact",
    reorder?.dim && "drag-source",
    reorder?.selected && "selected",
    was !== undefined && "renumbered",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={rowCls} data-drop-ids={g.id}>
      {reorder?.onGrip && (
        <span
          className="series-grip"
          role="button"
          tabIndex={-1}
          aria-label={t("sv4_drag_handle")}
          title={t("sv4_drag_handle")}
          onPointerDown={reorder.onGrip}
        >
          <Icon name="grip" size="sm" />
        </span>
      )}
      {compact && mediaBox}
      {!compact && <span className="series-row-n">#{g.seq}</span>}
      {!compact && (
        <span className="series-row-rail" aria-hidden="true">
          <i className={status} />
        </span>
      )}
      <div className="series-row-body">
        <div className="series-row-meta">
          {compact && <i className={`series-row-dot ${status}`} aria-hidden="true" />}
          {reorder?.selecting && (
            <button
              type="button"
              role="checkbox"
              aria-checked={reorder.selected}
              aria-label={t("sv4_select_attempt", { n: g.seq })}
              className={`series-check${reorder.selected ? " on" : ""}`}
              onClick={reorder.onToggle}
            >
              {reorder.selected && <Icon name="check" size="sm" />}
            </button>
          )}
          {compact && <span className="series-row-n-inline">#{g.seq}</span>}
          {wasTag}
          <strong className={`series-status ${status}`}>{t(`status_${status}`)}</strong>
          {!compact && <time dateTime={g.created_at} title={fullTimeText}>{timeText}</time>}
          {!compact && runtime && <span>· {runtime}</span>}
          {!compact && (
            <span className="series-params">
              ·{" "}
              {params.map((k, i) => (
                <span key={k}>
                  <span className={changed.has(k) ? "changed" : undefined}>{paramText[k]}</span>
                  {i < params.length - 1 ? " · " : ""}
                </span>
              ))}
            </span>
          )}
          {compact ? (
            <Menu
              className="series-row-more"
              items={[...markActions, ...moves, ...actions]}
              renderTrigger={({ open, toggle }) => (
                <IconButton icon="more" size="sm" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
              )}
            />
          ) : (
            <span className="series-row-actions">
              {actions.map((a) => (
                <button key={a.label} type="button" className="series-ghost" onClick={a.onSelect}>
                  {a.label}
                </button>
              ))}
              {(moves.length > 0 || markActions.length > 0) && (
                <Menu
                  items={[...markActions, ...moves, ...actions]}
                  renderTrigger={({ open, toggle }) => (
                    <IconButton icon="more" size="sm" label={t("more_actions")} aria-expanded={open} onClick={toggle} />
                  )}
                />
              )}
            </span>
          )}
        </div>
        {compact && failed && <p className={`series-row-reason ${status}`}>{reasonText}</p>}
        {compact && !output && g.status === "success" && (
          <p className="series-row-reason deleted">{t("series_output_deleted")}</p>
        )}
        {prompt}
        {inputs.length > 0 && (
          <div className={`series-row-inputs${changed.has("inputs") ? " changed" : ""}`}>
            {inputs.slice(0, 4).map((im) =>
              im.deleted_at ? (
                <span key={im.id} className="deleted-tile"><Icon name="imageMissing" size="sm" /></span>
              ) : (
                <img key={im.id} src={imgThumbUrl(im)} alt="" loading="lazy" onClick={() => onOpen(im)} />
              ),
            )}
            <span>{t("inputs_n", { n: inputs.length })}</span>
          </div>
        )}
        {compact && (
          <p className="series-row-when">
            <time dateTime={g.created_at} title={fullTimeText}>{timeText}</time>
            {runtime && <span> · {runtime}</span>}
          </p>
        )}
      </div>
      {!compact && mediaBox}
    </li>
  );
}
