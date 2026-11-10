import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type HistoryResult,
  type ImageRow,
  imgThumbUrl,
  providerOf,
  type SeriesDetail as SeriesDetailRow,
  type SeriesGeneration,
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
import { useSeries } from "../seriesStore";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { Switch } from "./ComposerControls";
import { SeriesDot, successRate } from "./SeriesBits";
import { MoveToThemeDialog, SeriesEditDialog } from "./SeriesDialogs";
import { HiddenVersionRow, VersionGroup, VersionSkeleton } from "./SeriesVersionGroup";
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
const FILM_HEIGHT = 96;
const BEST_HEIGHT = 180;
const OUTPUT_WIDTH = 88;
const COMPACT_BEST_HEIGHT = 140;
const COMPACT_FILM_HEIGHT = 64;
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
  const [counts, setCounts] = useState({ all: 0, success: 0, blocked: 0, error: 0 });
  const [filter, setFilter] = useState<HistoryResult | "all">("all");
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
        const [d, tl, vs] = await Promise.all([
          seriesApi.get(id),
          // The Changes view only needs the filter counts from here.
          seriesApi.timeline(id, { status, limit: view === "attempts" ? rowLimit : 1 }),
          // The Attempts view only needs the version count from here.
          seriesApi.versions(id, { status, limit: view === "changes" ? versionLimit : 1 }),
        ]);
        if (token !== loadToken.current) return;
        setDetail(d);
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

  const setBest = async (imageId: number | null) => {
    try {
      await seriesApi.update(id, { bestImageId: imageId });
      await store.reload([id]);
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
  const bestId = detail?.best_image?.id ?? null;
  const best = detail?.best_image ?? outputs[outputs.length - 1] ?? null;
  const bestSeq = useMemo(() => {
    if (!detail?.best_image) return null;
    return rows.find((r) => r.output_image_id === detail.best_image?.id)?.seq ?? null;
  }, [detail, rows]);

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
    detail.archived
      ? { label: t("series_unarchive"), icon: "unarchive", onSelect: () => void archive(false) }
      : { label: t("series_archive"), icon: "archive", onSelect: () => void archive(true) },
    ...(bestId ? [{ label: t("series_clear_best"), icon: "best" as const, onSelect: () => void setBest(null) }] : []),
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
        isBest={!!g.output_image_id && g.output_image_id === bestId}
        onOpen={(img) => onOpenViewer(img, outputs.length ? outputs : [img])}
        onReuse={() => onReuse(g)}
        onRerun={onRerun && g.source !== "manual" && isReady(providerOf(g)) ? () => onRerun(g) : undefined}
        onSetBest={g.outputImage && !g.outputImage.deleted_at ? () => void setBest(g.outputImage!.id) : undefined}
        reasonText={reason(g.raw_finish, providerOf(g)) || g.error_message || t("no_output")}
        timeText={when.short}
        fullTimeText={when.full}
      />
    );
  };

  /** ⋯ of a version: acts on its latest attempt (same configuration). */
  const versionMenu = (v: SeriesVersion): MenuItem[] => {
    const latest = v.attempts[v.attempts.length - 1];
    if (!latest) return [];
    const g = attemptRow(v, latest, id);
    return [
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

      {outputs.length > 0 && best && (
        <section className={`series-outputs${compact ? " compact" : ""}`} aria-label={t("series_outputs")}>
          <figure className="series-best">
            <button
              type="button"
              className="series-best-img"
              style={{
                height: compact ? COMPACT_BEST_HEIGHT : BEST_HEIGHT,
                width: Math.round((compact ? COMPACT_BEST_HEIGHT : BEST_HEIGHT) * ratioOf(best)),
              }}
              onClick={() => onOpenViewer(best, outputs)}
              title={t("open_viewer")}
            >
              <img src={imgThumbUrl(best)} alt="" draggable={false} />
            </button>
            <figcaption>
              {bestId ? (bestSeq ? t("series_best_n", { n: bestSeq }) : t("series_best")) : t("series_latest")}
            </figcaption>
          </figure>
          <div className="series-film-wrap">
            <div className="series-film">
              {outputs.map((img) => {
                const h = compact ? COMPACT_FILM_HEIGHT : FILM_HEIGHT;
                return (
                  <button
                    key={img.id}
                    type="button"
                    className={`series-film-item${img.id === bestId ? " best" : ""}`}
                    style={{ height: h, width: Math.round(h * ratioOf(img)) }}
                    title={t("open_viewer")}
                    onClick={() => onOpenViewer(img, outputs)}
                  >
                    <img src={imgThumbUrl(img)} alt="" loading="lazy" draggable={false} />
                  </button>
                );
              })}
            </div>
            <span className="series-film-caption">{t("series_all_outputs", { n: outputs.length })}</span>
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
        {!compact && <span className="series-order">{t("series_newest_first")}</span>}
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

      {view === "changes" ? (
        loading && versions.length === 0 ? (
          <ol className="series-versions"><VersionSkeleton /></ol>
        ) : versions.length === 0 ? (
          <div className="series-empty">{detail.records === 0 ? t("series_detail_empty") : t("no_results")}</div>
        ) : (
          <ol className="series-versions" aria-label={t("sv2_view_changes")}>
            {versions.map((v) =>
              v.hidden ? (
                <HiddenVersionRow key={v.version} v={v} />
              ) : (
                <VersionGroup
                  key={v.version}
                  v={v}
                  compact={compact}
                  filtered={filter !== "all"}
                  onOpen={(img) => onOpenViewer(img, outputs.length ? outputs : [img])}
                  reasonOf={(a) => reason(a.raw_finish, a.provider) || a.error_message || t("no_output")}
                  menu={versionMenu(v)}
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
  isBest,
  onOpen,
  onReuse,
  onRerun,
  onSetBest,
  reasonText,
  timeText,
  fullTimeText,
}: {
  g: SeriesGeneration;
  compact: boolean;
  showChanges: boolean;
  /** First attempt of version K (inside an expanded version group). */
  firstOf?: number;
  isBest: boolean;
  onOpen: (img: ImageRow) => void;
  onReuse: () => void;
  onRerun?: () => void;
  onSetBest?: () => void;
  reasonText: string;
  timeText: string;
  fullTimeText: string;
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
    ...(onSetBest && !isBest ? [{ label: t("series_set_best"), icon: "best" as const, onSelect: onSetBest }] : []),
  ];

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
    <button
      type="button"
      className={`series-row-output${isBest ? " best" : ""}`}
      style={{ aspectRatio: `${output.width} / ${output.height}` }}
      onClick={() => onOpen(output)}
      title={t("open_viewer")}
    >
      <img src={imgThumbUrl(output)} alt="" loading="lazy" draggable={false} />
    </button>
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

  return (
    <li className={`series-row${compact ? " compact" : ""}`}>
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
          {compact && <span className="series-row-n-inline">#{g.seq}</span>}
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
          {isBest && <span className="series-best-flag">{t("series_best")}</span>}
          {compact ? (
            <Menu
              className="series-row-more"
              items={actions}
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
