import { type CSSProperties, Fragment, useEffect, useRef, useState } from "react";
import { api, Generation, HistoryResult, ImageRow, ProviderId, providerOf, Tag } from "../api";
import { useI18n } from "../i18n";
import { dayKey, dayLabel, sortableTime } from "../historyTime";
import { useFitColumns } from "../useFitColumns";
import { useProviders } from "../useProviders";
import AddHistoryModal from "../components/AddHistoryModal";
import { pageSizedToColumns } from "../pageSize";
import SearchBox from "../components/SearchBox";
import TagFilterRow from "../components/TagFilterRow";
import { useToast } from "../components/Toast";
import { copyText } from "../clipboard";
import { useRemote } from "../remote";
import { RemoteChip } from "../components/RemoteIndicator";
import Icon from "../components/ui/Icon";
import appIcon from "../assets/app-icon.png";
import HistoryItem, { type HistoryLayout } from "../components/HistoryItem";
import { Button } from "../components/ui/Button";
import Segmented from "../components/ui/Segmented";
import { FilterPopover, PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";
import type { ViewerPager } from "../components/ImageViewer";
import {
  type ContextMenuSection,
  type ContextMenuShortcut,
  useContextMenu,
} from "../components/ui/ContextMenu";
import { downloadImage } from "../components/GenerationCard";
import CustomSelect from "../components/CustomSelect";
import Popover from "../components/ui/Popover";
import { SeriesChip } from "../components/SeriesBits";
import { useSeriesActions } from "../components/SeriesMenu";
import { seriesPathText, useSeries } from "../seriesStore";

const COMPACT_PAGE_SIZE = 12;
const FULL_PAGE_SIZE = 30;
const HISTORY_COLUMNS_KEY = "imagen-history-columns";
const HISTORY_COLUMN_OPTIONS = [1, 2, 3];
const HISTORY_COLUMN_OPTIONS_FULL = [1, 2, 3, 4, 5];
const HISTORY_LAYOUT_KEY = "imagen-history-layout";

function initialHistoryLayout(): HistoryLayout {
  return localStorage.getItem(HISTORY_LAYOUT_KEY) === "list" ? "list" : "grid";
}

function initialHistoryColumns() {
  const saved = Number(localStorage.getItem(HISTORY_COLUMNS_KEY));
  return HISTORY_COLUMN_OPTIONS_FULL.includes(saved) ? saved : 2;
}

export default function History({
  onReuse,
  onRerun,
  onUseAsRef,
  trayIds = [],
  onRemoveFromTray,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
  live = false,
  phone = false,
}: {
  onReuse: (g: Generation) => void;
  onRerun?: (g: Generation) => void;
  onUseAsRef?: (img: ImageRow) => void;
  trayIds?: number[];
  onRemoveFromTray?: (img: ImageRow) => void;
  onOpenViewer: (
    img: ImageRow,
    list: ImageRow[],
    pager?: ViewerPager,
    onIndexChange?: (globalIndex: number, image?: ImageRow) => void,
  ) => void;
  compact?: boolean;
  refreshKey?: number;
  live?: boolean;
  phone?: boolean;
}) {
  const { t, lang } = useI18n();
  const { isReady, providers } = useProviders();
  const toast = useToast();
  const { open: openContextMenu } = useContextMenu();
  const { remote } = useRemote();
  const [gens, setGens] = useState<Generation[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState<"vertex" | "manual" | null>(null);
  const [onlyWithImage, setOnlyWithImage] = useState(false);
  const [resultFilter, setResultFilter] = useState<HistoryResult | null>(null);
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<ProviderId | null>(null);
  // null = any, "none" = not in a series, otherwise one series id.
  const [seriesFilter, setSeriesFilter] = useState<number | "none" | null>(null);
  const seriesStore = useSeries();
  // Multi-select: generation ids. Long-press (phone) or the toolbar enters it.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchSeriesOpen, setBatchSeriesOpen] = useState(false);
  const longPress = useRef<number | null>(null);
  const [query, setQuery] = useState("");
  const [editingGen, setEditingGen] = useState<Generation | null>(null);
  const [duplicatingGen, setDuplicatingGen] = useState<Generation | null>(null);
  const [columns, setColumns] = useState(initialHistoryColumns);
  const [layout, setLayout] = useState(initialHistoryLayout);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [outputTotal, setOutputTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Enter grid rows per page, never a ragged last row; list view has one item
  // per row, so it keeps the plain target size. The phone grid is two columns;
  // elsewhere columns drop while cards would be too narrow for their buttons.
  const rootRef = useRef<HTMLDivElement>(null);
  const fitColumns = useFitColumns(rootRef, columns);
  const effectiveColumns = phone ? 2 : fitColumns;
  const pageSize = pageSizedToColumns(
    compact ? COMPACT_PAGE_SIZE : FULL_PAGE_SIZE,
    layout === "list" ? 1 : effectiveColumns,
  );

  const filterParams = {
    tag: tagFilter ?? undefined,
    q: query || undefined,
    kind: kindFilter ?? undefined,
    status: resultFilter ?? undefined,
    model: modelFilter ?? undefined,
    provider: providerFilter ?? undefined,
    series: seriesFilter ?? undefined,
  };
  const filterDeps = [tagFilter, kindFilter, onlyWithImage, query, resultFilter, modelFilter, providerFilter, seriesFilter];
  const moreFilters = [resultFilter, modelFilter, providerFilter, seriesFilter].filter((v) => v !== null).length;

  const load = (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setLoadError(null);
    }
    Promise.all([
      api.listGenerations({
        limit: pageSize,
        offset: page * pageSize,
        ...filterParams,
        withOutput: onlyWithImage,
      }),
      api.listTags(),
    ])
      .then(([r, tagsRes]) => {
        setGens(r.generations);
        setTotal(r.total);
        setOutputTotal(r.output_total);
        setTags(tagsRes.tags);
        if (r.total > 0 && page * pageSize >= r.total) {
          setPage(Math.max(0, Math.ceil(r.total / pageSize) - 1));
        }
      })
      .catch((e) => {
        // A background refresh should never replace the current card with a
        // flashing error state. The next normal refresh can surface an error.
        if (!quiet) setLoadError((e as Error).message);
      })
      .finally(() => {
        if (!quiet) setLoading(false);
      });
  };

  useEffect(load, [page, pageSize, refreshKey, ...filterDeps]);

  // While a request is in flight, poll only when History is actually mounted.
  // This makes the backend-created `running` placeholder appear without
  // refreshing Library or the rest of the workspace.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => load(true), 3000);
    return () => window.clearInterval(id);
  }, [live, page, pageSize, ...filterDeps]);

  const toggleStar = async (img: ImageRow) => {
    try {
      await api.patchImage(img.id, { starred: !img.starred });
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleContextStar = async (img: ImageRow) => {
    const next = !img.starred;
    try {
      await api.patchImage(img.id, { starred: next });
      img.starred = next ? 1 : 0;
      load();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleTray = (img: ImageRow) => {
    if (trayIds.includes(img.id) && onRemoveFromTray) onRemoveFromTray(img);
    else onUseAsRef?.(img);
  };

  const series = useSeriesActions(() => load(true));
  const targetFor = (list: Generation[]) => ({
    body: { generationIds: list.map((g) => g.id) },
    members: list.map((g) => g.series_id ?? null),
  });
  const selectedGens = () => gens.filter((g) => selected.has(g.id));
  const toggleSelected = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setBatchSeriesOpen(false);
  };

  const openBatchMenu = (generation: Generation, trigger: HTMLElement, x: number, y: number) => {
    let ids = selected;
    if (!ids.has(generation.id)) {
      ids = new Set(ids);
      ids.add(generation.id);
      setSelected(ids);
    }
    const list = gens.filter((g) => ids.has(g.id));
    const counts = { success: 0, blocked: 0, error: 0 };
    for (const g of list) {
      if (g.status === "success") counts.success++;
      else if (g.status === "blocked") counts.blocked++;
      else counts.error++;
    }
    const sameSeries = list[0]?.series_id && list.every((g) => g.series_id === list[0].series_id) ? list[0].series_id : null;
    openContextMenu({
      x,
      y,
      trigger,
      images: list.flatMap((g) => (g.outputImage && !g.outputImage.deleted_at ? [g.outputImage] : [])).slice(0, 3),
      title: t("series_n_generations", { n: list.length }),
      subtitle: [
        counts.success ? `${counts.success} ${t("hist_result_success")}` : null,
        counts.blocked ? `${counts.blocked} ${t("hist_result_blocked")}` : null,
        counts.error ? `${counts.error} ${t("hist_result_error")}` : null,
      ].filter(Boolean).join(" · "),
      sections: [
        [series.menuItem(targetFor(list))],
        [
          {
            icon: "copy",
            label: t("series_copy_prompts"),
            onSelect: async () =>
              toast((await copyText(list.map((g) => g.prompt).filter(Boolean).join("\n\n"))) ? t("copied") : t("copy_failed")),
          },
          ...(sameSeries
            ? [{
                icon: "selectAll" as const,
                label: t("series_select_all_in"),
                onSelect: () => {
                  setSeriesFilter(sameSeries);
                  setPage(0);
                },
              }]
            : []),
        ],
      ],
      ariaLabel: t("batch_actions"),
    });
  };

  const openHistoryMenu = (
    generation: Generation,
    img: ImageRow,
    isOutput: boolean,
    trigger: HTMLElement,
    x: number,
    y: number,
    onView: () => void,
  ) => {
    const canToggleRef = !!onUseAsRef;
    const inTray = trayIds.includes(img.id);
    const shortcuts: ContextMenuShortcut[] = [
      {
        icon: "view",
        label: t("open_viewer"),
        onSelect: onView,
      },
      ...(canToggleRef
        ? [
            {
              icon: inTray ? ("removeFromRefs" as const) : ("addToRefs" as const),
              label: inTray ? t("shortcut_remove_ref") : t("shortcut_input"),
              ariaLabel: inTray ? t("remove_ref") : t("add_to_input"),
              onSelect: () => toggleTray(img),
            },
          ]
        : []),
      {
        icon: "favorite",
        label: img.starred ? t("favorited") : t("favorite"),
        ariaLabel: img.starred ? t("unfavorite") : t("favorite"),
        selected: !!img.starred,
        filled: !!img.starred,
        onSelect: () => toggleContextStar(img),
      },
      {
        icon: "download",
        label: t("download"),
        onSelect: () => downloadImage(img),
      },
    ];
    if (selectMode) {
      openBatchMenu(generation, trigger, x, y);
      return;
    }
    const recordActions: ContextMenuSection = [];
    if (isOutput && generation.prompt) {
      recordActions.push({
        icon: "copy",
        label: t("copy_prompt"),
        onSelect: async () =>
          toast((await copyText(generation.prompt)) ? t("copied") : t("copy_failed")),
      });
      recordActions.push({
        icon: "reuse",
        label: t("reuse"),
        onSelect: () => onReuse(generation),
      });
      if (onRerun && generation.source !== "manual" && isReady(providerOf(generation))) {
        recordActions.push({
          icon: "rerun",
          label: t("rerun_short"),
          onSelect: () => onRerun(generation),
        });
      }
    }
    const seriesSection: ContextMenuSection = isOutput ? [series.menuItem(targetFor([generation]))] : [];
    openContextMenu({
      x,
      y,
      trigger,
      images: [img],
      prompt: isOutput ? generation.prompt : undefined,
      sourceLabel: generation.source === "manual" ? t("imported_badge") : undefined,
      shortcuts,
      sections: [recordActions, seriesSection].filter((section) => section.length > 0),
      ariaLabel: t("image_menu"),
    });
  };

  useEffect(() => {
    localStorage.setItem(HISTORY_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    localStorage.setItem(HISTORY_LAYOUT_KEY, layout);
  }, [layout]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPages = total > pageSize;

  const openOutputViewer = (img: ImageRow, generation: Generation, gridIndex: number) => {
    img.generation_offset = page * pageSize + gridIndex;
    onOpenViewer(
      img,
      [img],
      {
        // The clicked image is the first item, at its unique-output position.
        offset: generation.output_index ?? 0,
        total: outputTotal,
        batchSize: pageSize,
        fetch: async (nextOffset, limit) => {
          const r = await api.listGenerations({
            limit,
            offset: nextOffset,
            ...filterParams,
            uniqueOutputs: true,
          });
          const outputs: ImageRow[] = [];
          r.generations.forEach((g) => {
            const output = g.outputImage;
            if (!output || output.deleted_at) return;
            output.generation_offset = g.generation_offset;
            outputs.push(output);
          });
          return outputs;
        },
      },
      (globalIndex, output) => {
        const generationOffset = output?.generation_offset ?? globalIndex;
        setPage(Math.floor(generationOffset / pageSize));
      },
    );
  };

  const pager = hasPages ? (
    <div className="pager">
      <button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
        {t("prev_page")}
      </button>
      <span className="muted small">
        {t("page_status", { page: page + 1, pages: pageCount, total })}
      </span>
      <button
        disabled={page >= pageCount - 1 || loading}
        onClick={() => setPage((p) => p + 1)}
      >
        {t("next_page")}
      </button>
    </div>
  ) : null;

  // Phone keeps a single compact pager above the list (the bottom copy is
  // hidden), matching the library island's ‹ 1/3 › + total row.
  const phonePager = (
    <div className="phone-pager-row">
      <div className="phone-pg">
        {hasPages && (
          <button
            type="button"
            className="phone-pg-btn"
            aria-label={t("prev_page")}
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            <Icon name="prev" size="sm" />
          </button>
        )}
        <span>
          {hasPages
            ? t("phone_page_status", { page: page + 1, pages: pageCount })
            : t("phone_total_records", { n: total })}
        </span>
        {hasPages && (
          <button
            type="button"
            className="phone-pg-btn"
            aria-label={t("next_page")}
            disabled={page >= pageCount - 1 || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            <Icon name="next" size="sm" />
          </button>
        )}
      </div>
      {hasPages && <span className="phone-pager-total">{t("phone_total_records", { n: total })}</span>}
    </div>
  );

  const tagBar = (
    <TagFilterRow
      tags={tags}
      value={tagFilter}
      onChange={(id) => {
        setTagFilter(id);
        setPage(0);
      }}
    />
  );

  const clearMoreFilters = () => {
    setResultFilter(null);
    setModelFilter(null);
    setProviderFilter(null);
    setSeriesFilter(null);
    setPage(0);
  };
  // Every model any provider serves (catalog order, one entry per id).
  const modelOptions = providers
    .flatMap((p) => p.models)
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
  const pickFilter = <T extends string>(setter: (v: T | null) => void) => (v: string) => {
    setter(v === "all" ? null : (v as T));
    setPage(0);
  };
  const moreFilterPopover = (
    <FilterPopover active={moreFilters} onClear={clearMoreFilters}>
      <PopoverSection label={t("hist_filter_result")}>
        <Segmented<string>
          value={resultFilter ?? "all"}
          onChange={pickFilter<HistoryResult>(setResultFilter)}
          options={[
            { value: "all", label: t("filter_all") },
            { value: "success", label: t("hist_result_success") },
            { value: "blocked", label: t("hist_result_blocked") },
            { value: "error", label: t("hist_result_error") },
          ]}
        />
      </PopoverSection>
      <PopoverSection label={t("hist_filter_model")}>
        <Segmented<string>
          value={modelFilter ?? "all"}
          onChange={pickFilter<string>(setModelFilter)}
          options={[
            { value: "all", label: t("filter_all") },
            ...modelOptions.map((m) => ({ value: m.id, label: m.label })),
          ]}
        />
      </PopoverSection>
      <PopoverSection label={t("series_series")}>
        <CustomSelect<string>
          value={seriesFilter === null ? "all" : String(seriesFilter)}
          onChange={(v) => {
            setSeriesFilter(v === "all" ? null : v === "none" ? "none" : Number(v));
            setPage(0);
          }}
          options={[
            { id: "all", label: t("series_filter_any") },
            { id: "none", label: t("series_filter_none") },
            ...seriesStore.leaves.map((leaf) => ({
              id: String(leaf.id),
              label: seriesPathText(seriesStore.get(leaf.id), t("series_no_theme")),
            })),
          ]}
        />
      </PopoverSection>
      <PopoverSection label={t("hist_filter_provider")}>
        <Segmented<string>
          value={providerFilter ?? "all"}
          onChange={pickFilter<ProviderId>(setProviderFilter)}
          options={[
            { value: "all", label: t("filter_all") },
            ...providers.map((p) => ({ value: p.id, label: p.label })),
          ]}
        />
      </PopoverSection>
    </FilterPopover>
  );

  // List view: a heading before the first record of each local day.
  const now = new Date();
  const dayHeading = (index: number) => {
    if (layout !== "list") return null;
    const d = sortableTime(gens[index].created_at);
    const prev = index > 0 ? sortableTime(gens[index - 1].created_at) : null;
    if (index > 0 && (d ? dayKey(d) : "") === (prev ? dayKey(prev) : "")) return null;
    return (
      <h3 className="hlist-day">{d ? dayLabel(d, now, lang, t) : t("history_unknown_day")}</h3>
    );
  };

  // Collect unique tags from all images in a generation (inputs + output).
  const genTags = (g: Generation) => {
    const all = [...(g.inputs ?? []), ...(g.outputImage ? [g.outputImage] : [])];
    const seen = new Set<number>();
    return all.flatMap((im) => im.tags ?? []).filter((tg) => {
      if (seen.has(tg.id)) return false;
      seen.add(tg.id);
      return true;
    });
  };

  return (
    <div ref={rootRef} className={phone ? "history-phone" : undefined}>
      {phone && (
        <div className="phone-head">
          <img className="phone-logo" src={appIcon} alt="" />
          <h1>
            {t("tab_history")} <span>{total}</span>
          </h1>
          {remote && <RemoteChip />}
        </div>
      )}
      <div className="history-toolbar">
        <div className="history-toolbar-row">
          <SearchBox
            value={query}
            onChange={(q) => {
              setQuery(q);
              setPage(0);
            }}
            placeholder={t("search_placeholder_history")}
          />
          <div className="history-toolbar-controls">
          {layout === "grid" && !phone && (
          <ViewPopover>
            <PopoverSection label={t("columns_per_row")}>
              <Segmented
                dense
                value={columns}
                onChange={(n) => {
                  setColumns(n);
                  setPage(0);
                }}
                options={(compact ? HISTORY_COLUMN_OPTIONS : HISTORY_COLUMN_OPTIONS_FULL).map((n) => ({
                  value: n,
                  label: String(n),
                }))}
              />
            </PopoverSection>
          </ViewPopover>
          )}
          <Segmented
            className="view-seg"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "grid", label: t("view_grid"), icon: "columns", iconOnly: true, title: t("view_grid") },
              { value: "list", label: t("view_list"), icon: "listView", iconOnly: true, title: t("view_list") },
            ]}
          />
          </div>
        </div>
        <div className={`filter-row${phone ? " phone-filter-row" : ""}`}>
          <Segmented
            value={kindFilter ?? "all"}
            onChange={(v) => {
              setKindFilter(v === "all" ? null : v);
              setPage(0);
            }}
            options={[
              { value: "all", label: t("filter_all") },
              { value: "vertex", label: t("hist_filter_vertex"), icon: "generated", iconOnly: phone, title: t("hist_filter_vertex") },
              { value: "manual", label: t("hist_filter_manual"), icon: "imported", iconOnly: phone, title: t("hist_filter_manual") },
            ]}
          />
          <Button
            className={`skip-toggle${onlyWithImage ? " on" : ""}`}
            icon="library"
            title={t("hist_filter_with_image")}
            aria-label={t("hist_filter_with_image")}
            aria-pressed={onlyWithImage}
            onClick={() => {
              setOnlyWithImage((value) => !value);
              setPage(0);
            }}
          >
            <span className="filter-label">{t("hist_filter_with_image")}</span>
          </Button>
          {moreFilterPopover}
          {!phone && (
            <Button
              className={`skip-toggle${selectMode ? " on" : ""}`}
              icon="selectMode"
              title={t("select_mode")}
              aria-label={t("select_mode")}
              aria-pressed={selectMode}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            >
              <span className="filter-label">{t("select_mode")}</span>
            </Button>
          )}
        </div>
        {seriesFilter !== null && (
          <div className="series-filter-active">
            <span>
              {seriesFilter === "none"
                ? t("series_filter_none")
                : t("series_filter_is", {
                    name: seriesPathText(seriesStore.get(seriesFilter), t("series_no_theme")),
                  })}
            </span>
            <Button variant="link" onClick={() => { setSeriesFilter(null); setPage(0); }}>
              {t("clear_filters")}
            </Button>
          </div>
        )}
        {tagBar}
      </div>
      {phone ? phonePager : pager}

      {loading ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          <span className="spinner" /> {t("loading")}
        </div>
      ) : loadError ? (
        <div className={`panel history-panel${compact ? " compact" : ""}`}>
          <div className="load-error">
            <span className="small">{t("load_error", { msg: loadError })}</span>
            <button onClick={() => load()}>{t("retry")}</button>
          </div>
        </div>
      ) : gens.length === 0 ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          {query || tagFilter !== null || kindFilter !== null || onlyWithImage || moreFilters > 0 ? (
            <div className="empty-state">
              <span>{t("no_results")}</span>
              <button
                onClick={() => {
                  setQuery("");
                  setTagFilter(null);
                  setKindFilter(null);
                  setOnlyWithImage(false);
                  setResultFilter(null);
                  setModelFilter(null);
                  setProviderFilter(null);
                  setSeriesFilter(null);
                  setPage(0);
                }}
              >
                {t("clear_filters")}
              </button>
            </div>
          ) : (
            t("history_empty")
          )}
        </div>
      ) : (
        <div
          className={`history-list hlist ${layout}${compact ? " compact" : ""}${phone && layout === "grid" ? " phone-cols2" : ""}`}
          style={layout === "grid" ? ({ "--history-columns": effectiveColumns } as CSSProperties) : undefined}
        >
          {gens.map((g, index) => {
            const outImg = g.outputImage && !g.outputImage.deleted_at ? g.outputImage : null;
            const missing = !!g.outputImage?.deleted_at || (g.status === "success" && !g.outputImage);
            return (
              <Fragment key={g.id}>
              {dayHeading(index)}
              <div
                className={`hsel-wrap${selectMode ? " selecting" : ""}${selected.has(g.id) ? " selected" : ""}`}
                onPointerDown={(e) => {
                  if (selectMode || e.pointerType === "mouse") return;
                  longPress.current = window.setTimeout(() => {
                    setSelectMode(true);
                    setSelected(new Set([g.id]));
                  }, 500);
                }}
                onPointerUp={() => longPress.current && window.clearTimeout(longPress.current)}
                onPointerCancel={() => longPress.current && window.clearTimeout(longPress.current)}
                onPointerMove={() => longPress.current && window.clearTimeout(longPress.current)}
              >
              <HistoryItem
                seriesChip={g.series_id ? <SeriesChip seriesId={g.series_id} /> : undefined}
                g={g}
                layout={layout}
                output={outImg}
                missing={missing}
                onOpen={() => outImg && openOutputViewer(outImg, g, index)}
                onToggleStar={outImg ? () => toggleStar(outImg) : undefined}
                onOpenInput={(im) => onOpenViewer(im, g.inputs ?? [])}
                tags={genTags(g)}
                onReuse={() => onReuse(g)}
                onRerun={onRerun && isReady(providerOf(g)) ? () => onRerun(g) : undefined}
                onUseAsRef={onUseAsRef && outImg ? () => onUseAsRef(outImg) : undefined}
                onImageContextMenu={(img, trigger, x, y, isOutput, onView) =>
                  openHistoryMenu(g, img, isOutput, trigger, x, y, onView)
                }
                onEdit={() => setEditingGen(g)}
                onDuplicate={() => setDuplicatingGen(g)}
              />
              {selectMode && (
                <button
                  type="button"
                  className="hsel-cover"
                  aria-pressed={selected.has(g.id)}
                  aria-label={t("select_image")}
                  onClick={() => toggleSelected(g.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if ((e.nativeEvent as PointerEvent).pointerType && (e.nativeEvent as PointerEvent).pointerType !== "mouse") return;
                    openBatchMenu(g, e.currentTarget, e.clientX, e.clientY);
                  }}
                >
                  <span className="hsel-check">{selected.has(g.id) && <Icon name="check" size="sm" />}</span>
                </button>
              )}
              </div>
              </Fragment>
            );
          })}
        </div>
      )}

      {!phone && pager}

      {selectMode && (
        <div className={`batch-bar history-batch${phone ? " phone" : ""}`}>
          <div className="batch-bar-row">
            <span className="batch-count">{t("selected_n", { n: selected.size })}</span>
            <Button
              variant="link"
              disabled={gens.length === 0 || gens.every((g) => selected.has(g.id))}
              onClick={() => setSelected(new Set([...selected, ...gens.map((g) => g.id)]))}
            >
              {t("select_all")}
            </Button>
            <div className="spacer" />
            <Popover
              fixed
              align="end"
              open={batchSeriesOpen}
              onClose={() => setBatchSeriesOpen(false)}
              panelClassName="series-popover"
              panelProps={{ role: "dialog", "aria-label": t("series_add_to") }}
              trigger={
                <Button
                  size="sm"
                  variant="primary"
                  icon="series"
                  disabled={selected.size === 0}
                  aria-expanded={batchSeriesOpen}
                  onClick={() => setBatchSeriesOpen((v) => !v)}
                >
                  {t("series_add_to_ellipsis")}
                </Button>
              }
            >
              {series.picker(targetFor(selectedGens()), () => setBatchSeriesOpen(false), true)}
            </Popover>
            <Button size="sm" icon="check" onClick={exitSelect}>{t("done")}</Button>
          </div>
        </div>
      )}
      {series.dialog}

      {editingGen && (
        <AddHistoryModal
          existing={editingGen}
          onClose={() => setEditingGen(null)}
          onSaved={() => {
            setEditingGen(null);
            load();
          }}
        />
      )}
      {duplicatingGen && (
        <AddHistoryModal
          duplicate={duplicatingGen}
          onClose={() => setDuplicatingGen(null)}
          onSaved={() => {
            setDuplicatingGen(null);
            load();
          }}
        />
      )}
    </div>
  );
}
