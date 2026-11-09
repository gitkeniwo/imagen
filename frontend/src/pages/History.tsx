import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Generation,
  type GenerationFilters,
  type HistoryResult,
  type ImageRow,
  type ProviderId,
  providerOf,
  type Tag,
} from "../api";
import { useI18n } from "../i18n";
import { dayLabel } from "../historyTime";
import { useFitColumns } from "../useFitColumns";
import { useProviders } from "../useProviders";
import AddHistoryModal from "../components/AddHistoryModal";
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
  type ContextMenuQuickAction,
  useContextMenu,
} from "../components/ui/ContextMenu";
import { downloadImage } from "../components/GenerationCard";
import CustomSelect from "../components/CustomSelect";
import Popover from "../components/ui/Popover";
import { SeriesChip } from "../components/SeriesBits";
import { useSeriesActions } from "../components/SeriesMenu";
import { seriesPathText, useSeries } from "../seriesStore";
import PositionLine from "../components/PositionLine";
import TimelineScrubber from "../components/LibraryScrubber";
import { CHUNK, useChunkedList } from "../useChunkedList";
import { useVirtualGrid } from "../useVirtualGrid";
import { useAnchoredRefresh } from "../useAnchoredRefresh";
import { useTimeline } from "../useTimeline";
import { dateOfDay } from "../timeline";

const HISTORY_COLUMNS_KEY = "imagen-history-columns";
const HISTORY_ANCHOR_KEY = "imagen-history-anchor:";
const HISTORY_COLUMN_OPTIONS = [1, 2, 3];
const HISTORY_COLUMN_OPTIONS_FULL = [1, 2, 3, 4, 5];
const HISTORY_LAYOUT_KEY = "imagen-history-layout";
const MAX_SELECT_IDS = 5000;
const ENSURE_DELAY_MS = 100;

function initialHistoryLayout(): HistoryLayout {
  return localStorage.getItem(HISTORY_LAYOUT_KEY) === "list" ? "list" : "grid";
}

function initialHistoryColumns() {
  const saved = Number(localStorage.getItem(HISTORY_COLUMNS_KEY));
  return HISTORY_COLUMN_OPTIONS_FULL.includes(saved) ? saved : 2;
}

function cssPx(
  element: HTMLElement | null,
  property: string,
  fallback: number,
) {
  if (!element) return fallback;
  const value = parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
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
  const [outputTotal, setOutputTotal] = useState(0);
  const [timelineTick, setTimelineTick] = useState(0);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [resultIds, setResultIds] = useState<{
    key: string;
    total: number;
    ids: number[];
  } | null>(null);
  const rowsById = useRef(new Map<number, Generation>());
  const stickyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fitColumns = useFitColumns(rootRef, columns);
  const effectiveColumns = phone ? 2 : fitColumns;
  const layoutKey = phone ? "phone" : compact ? "compact" : "full";

  const filterParams = useMemo<GenerationFilters>(
    () => ({
      tag: tagFilter ?? undefined,
      q: query.trim() || undefined,
      kind: kindFilter ?? undefined,
      status: resultFilter ?? undefined,
      model: modelFilter ?? undefined,
      provider: providerFilter ?? undefined,
      series: seriesFilter ?? undefined,
      withOutput: onlyWithImage || undefined,
    }),
    [kindFilter, modelFilter, onlyWithImage, providerFilter, query, resultFilter, seriesFilter, tagFilter],
  );
  const filtersKey = JSON.stringify(filterParams);
  const moreFilters = [resultFilter, modelFilter, providerFilter, seriesFilter].filter((v) => v !== null).length;

  const data = useChunkedList<Generation>({
    key: filtersKey,
    fetchChunk: async (offset, limit, signal) => {
      const result = await api.listGenerations(
        { ...filterParams, limit, offset },
        signal,
      );
      setOutputTotal((current) =>
        current === result.output_total ? current : result.output_total,
      );
      return { rows: result.generations, total: result.total };
    },
    fetchIds: async (offset, limit, signal) =>
      (
        await api.listGenerationIds(
          { ...filterParams, offset, limit },
          signal,
        )
      ).ids,
    idOf: (generation) => generation.id,
    onRows: (rows) => {
      for (const generation of rows) {
        rowsById.current.set(generation.id, generation);
      }
    },
  });
  const total = data.total;
  const loading = !data.ready;
  const loadError = data.error;
  const {
    timeline,
    loading: timelineLoading,
    error: timelineError,
  } = useTimeline(
    () => api.generationTimeline(filterParams),
    filtersKey,
    timelineTick,
  );
  const sections = useMemo(
    () => (layout === "list" ? timeline?.runStarts : undefined),
    [layout, timeline],
  );
  const grid = useVirtualGrid({
    count: total,
    columns: effectiveColumns,
    itemHeight: (width, element) =>
      layout === "list"
        ? cssPx(element, "--hcard-list-h", 148)
        : Math.max(0, width - 2) * 0.75 +
          cssPx(element, "--hcard-body-h", 192) +
          cssPx(element, "--hcard-grid-gap", 12) +
          2,
    sections,
    sectionHeaderHeight:
      layout === "list"
        ? (element) => cssPx(element, "--hlist-day-step", 38)
        : undefined,
    topInset: (scroller) => {
      const sticky = stickyRef.current;
      if (!sticky) return 0;
      return sticky.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    },
  });

  const { refresh, newCount, clearNew } = useAnchoredRefresh({
    data,
    grid,
    idOf: (generation) => generation.id,
    filtersKey,
    refreshKey,
    storageKey: `${HISTORY_ANCHOR_KEY}${layoutKey}:${layout}`,
    onRefreshDone: () => setTimelineTick((n) => n + 1),
  });
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!data.ready || total === 0) return;
    const timer = window.setTimeout(
      () => data.ensure(grid.startIndex, grid.endIndex),
      ENSURE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [data.ready, data.ensure, grid.endIndex, grid.startIndex, total]);

  const loadTags = () => {
    api
      .listTags()
      .then((result) => setTags(result.tags))
      .catch(() => {});
  };
  useEffect(loadTags, [refreshKey]);

  // While live, refresh the loaded chunks only; the anchored hook keeps the
  // reader in place and surfaces "↑ N new" for rows that arrived above.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => void refreshRef.current(), 3000);
    return () => window.clearInterval(id);
  }, [filtersKey, live]);

  useEffect(() => {
    localStorage.setItem(HISTORY_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    localStorage.setItem(HISTORY_LAYOUT_KEY, layout);
  }, [layout]);

  useEffect(() => {
    setJumpOpen(false);
  }, [filtersKey]);

  const toggleStar = async (img: ImageRow) => {
    try {
      await api.patchImage(img.id, { starred: !img.starred });
      void refresh();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleContextStar = async (img: ImageRow) => {
    const next = !img.starred;
    try {
      await api.patchImage(img.id, { starred: next });
      img.starred = next ? 1 : 0;
      void refresh();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleTray = (img: ImageRow) => {
    if (trayIds.includes(img.id) && onRemoveFromTray) onRemoveFromTray(img);
    else onUseAsRef?.(img);
  };

  const series = useSeriesActions(() => void refresh());
  const targetForIds = (ids: number[]) => ({
    body: { generationIds: ids },
    members: ids.map((id) => rowsById.current.get(id)?.series_id ?? null),
  });
  const targetFor = (list: Generation[]) =>
    targetForIds(list.map((generation) => generation.id));
  const selectedLoaded = () =>
    [...selected]
      .map((id) => rowsById.current.get(id))
      .filter((generation): generation is Generation => !!generation);
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
    const idList = [...ids];
    const list = selectedLoaded().filter((generation) => ids.has(generation.id));
    if (!list.some((row) => row.id === generation.id)) list.push(generation);
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
      title: t("series_n_generations", { n: idList.length }),
      subtitle: [
        counts.success ? `${counts.success} ${t("hist_result_success")}` : null,
        counts.blocked ? `${counts.blocked} ${t("hist_result_blocked")}` : null,
        counts.error ? `${counts.error} ${t("hist_result_error")}` : null,
      ].filter(Boolean).join(" · "),
      sections: [
        [series.menuItem(targetForIds(idList))],
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
                },
              }]
            : []),
        ],
      ],
      ariaLabel: t("batch_actions"),
    });
  };

  const allResultsSelected =
    total > 0 &&
    !!resultIds &&
    resultIds.key === filtersKey &&
    resultIds.total === total &&
    resultIds.ids.every((id) => selected.has(id));

  const selectAllResults = async () => {
    try {
      const result = await api.listGenerationIds({
        ...filterParams,
        limit: MAX_SELECT_IDS,
      });
      setResultIds({ key: filtersKey, total: result.total, ids: result.ids });
      setSelected((current) => new Set([...current, ...result.ids]));
      if (result.total > result.ids.length) {
        toast(t("select_limit", { n: MAX_SELECT_IDS.toLocaleString() }), "info");
      }
    } catch (error) {
      toast(t("op_failed", { msg: (error as Error).message }));
    }
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
    const quickActions: ContextMenuQuickAction[] = [
      {
        icon: "view",
        label: t("open_viewer"),
        onSelect: onView,
      },
      ...(canToggleRef
        ? [
            {
              icon: inTray ? ("removeFromRefs" as const) : ("addToRefs" as const),
              label: inTray ? t("quick_action_remove_ref") : t("quick_action_input"),
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
      quickActions,
      sections: [recordActions, seriesSection].filter((section) => section.length > 0),
      ariaLabel: t("image_menu"),
    });
  };

  const openOutputViewer = (img: ImageRow, generation: Generation, gridIndex: number) => {
    img.generation_offset = gridIndex;
    onOpenViewer(
      img,
      [img],
      {
        // The clicked image is the first item, at its unique-output position.
        offset: generation.output_index ?? 0,
        total: outputTotal,
        batchSize: CHUNK,
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
        grid.scrollToIndex(generationOffset, "nearest");
        data.ensure(generationOffset, generationOffset);
      },
    );
  };

  const tagBar = (
    <TagFilterRow
      tags={tags}
      value={tagFilter}
      onChange={(id) => {
        setTagFilter(id);
      }}
    />
  );

  const clearMoreFilters = () => {
    setResultFilter(null);
    setModelFilter(null);
    setProviderFilter(null);
    setSeriesFilter(null);
  };
  // Every model any provider serves (catalog order, one entry per id).
  const modelOptions = providers
    .flatMap((p) => p.models)
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
  const pickFilter = <T extends string>(setter: (v: T | null) => void) => (v: string) => {
    setter(v === "all" ? null : (v as T));
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

  // List view: a heading before the first record of each local day. The
  // timeline's runs already give every section's item index and need no rows.
  const sectionLabels = useMemo(() => {
    const labels = new Map<number, string>();
    if (layout !== "list" || !timeline) return labels;
    const now = new Date();
    timeline.runStarts.forEach((start, index) => {
      const day = timeline.runDays[index];
      labels.set(
        start,
        day
          ? dayLabel(dateOfDay(day.day), now, lang, t)
          : t("history_unknown_day"),
      );
    });
    return labels;
  }, [lang, layout, t, timeline]);

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

  const jumpToIndex = (next: number) => {
    if (total === 0) return;
    const index = Math.max(0, Math.min(total - 1, next));
    grid.scrollToIndex(index, "start");
    data.ensure(index, Math.min(total - 1, index + Math.max(1, grid.cols)));
    clearNew();
  };

  const positionLine = (
    <PositionLine
      total={total}
      index={grid.visibleStart}
      endIndex={grid.visibleEnd}
      atTop={grid.atTop}
      timeline={timeline}
      timelineLoading={timelineLoading}
      timelineError={timelineError}
      phone={phone}
      unit="records"
      buttonClass="list-position"
      newCount={newCount}
      jumpOpen={jumpOpen}
      onJumpOpenChange={setJumpOpen}
      onJump={jumpToIndex}
      onBackToTop={() => {
        clearNew();
        grid.scrollToTop(true);
      }}
      onNewClick={() => {
        clearNew();
        grid.scrollToTop(true);
      }}
    />
  );

  const sectionRowSet = useMemo(
    () => new Set(grid.sectionRows),
    [grid.sectionRows],
  );

  const renderCard = (generation: Generation, index: number) => {
    const outImg =
      generation.outputImage && !generation.outputImage.deleted_at
        ? generation.outputImage
        : null;
    const missing =
      !!generation.outputImage?.deleted_at ||
      (generation.status === "success" && !generation.outputImage);
    return (
      <div
        className={`hsel-wrap${selectMode ? " selecting" : ""}${
          selected.has(generation.id) ? " selected" : ""
        }`}
        onPointerDown={(event) => {
          if (selectMode || event.pointerType === "mouse") return;
          longPress.current = window.setTimeout(() => {
            setSelectMode(true);
            setSelected(new Set([generation.id]));
          }, 500);
        }}
        onPointerUp={() =>
          longPress.current && window.clearTimeout(longPress.current)
        }
        onPointerCancel={() =>
          longPress.current && window.clearTimeout(longPress.current)
        }
        onPointerMove={() =>
          longPress.current && window.clearTimeout(longPress.current)
        }
      >
        <HistoryItem
          seriesChip={
            generation.series_id ? (
              <SeriesChip seriesId={generation.series_id} />
            ) : undefined
          }
          g={generation}
          layout={layout}
          output={outImg}
          missing={missing}
          onOpen={() =>
            outImg && openOutputViewer(outImg, generation, index)
          }
          onToggleStar={outImg ? () => toggleStar(outImg) : undefined}
          onOpenInput={(img) =>
            onOpenViewer(img, generation.inputs ?? [])
          }
          tags={genTags(generation)}
          onReuse={() => onReuse(generation)}
          onRerun={
            onRerun && isReady(providerOf(generation))
              ? () => onRerun(generation)
              : undefined
          }
          onUseAsRef={
            onUseAsRef && outImg ? () => onUseAsRef(outImg) : undefined
          }
          onImageContextMenu={(img, trigger, x, y, isOutput, onView) =>
            openHistoryMenu(
              generation,
              img,
              isOutput,
              trigger,
              x,
              y,
              onView,
            )
          }
          onEdit={() => setEditingGen(generation)}
          onDuplicate={() => setDuplicatingGen(generation)}
        />
        {selectMode && (
          <button
            type="button"
            className="hsel-cover"
            aria-pressed={selected.has(generation.id)}
            aria-label={t("select_image")}
            onClick={() => toggleSelected(generation.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              const pointerType = (event.nativeEvent as PointerEvent).pointerType;
              if (pointerType && pointerType !== "mouse") return;
              openBatchMenu(
                generation,
                event.currentTarget,
                event.clientX,
                event.clientY,
              );
            }}
          >
            <span className="hsel-check">
              {selected.has(generation.id) && <Icon name="check" size="sm" />}
            </span>
          </button>
        )}
      </div>
    );
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
      <div className="history-toolbar" ref={stickyRef}>
        <div className="history-toolbar-row">
          <SearchBox
            value={query}
            onChange={(q) => {
              setQuery(q);
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
            <Button variant="link" onClick={() => setSeriesFilter(null)}>
              {t("clear_filters")}
            </Button>
          </div>
        )}
        {tagBar}
        {positionLine}
      </div>

      {loading ? (
        <div className={`panel muted history-panel${compact ? " compact" : ""}`}>
          <span className="spinner" /> {t("loading")}
        </div>
      ) : loadError ? (
        total === 0 ? (
          <div className={`panel history-panel${compact ? " compact" : ""}`}>
            <div className="load-error">
              <span className="small">{t("load_error", { msg: loadError })}</span>
              <button onClick={data.reset}>{t("retry")}</button>
            </div>
          </div>
        ) : (
          <div className="load-error">
            <span className="small">{t("load_error", { msg: loadError })}</span>
            <button onClick={() => data.ensure(grid.startIndex, grid.endIndex)}>
              {t("retry")}
            </button>
          </div>
        )
      ) : total === 0 ? (
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
                }}
              >
                {t("clear_filters")}
              </button>
            </div>
          ) : (
            t("history_empty")
          )}
        </div>
      ) : null}

      <div
        className="history-vgrid virtual-list"
        ref={grid.gridRef}
        style={{ height: grid.totalHeight }}
      >
        {layout === "grid" ? (
          <div
            ref={grid.windowRef}
            className={`history-list hlist grid${compact ? " compact" : ""}${
              phone ? " phone-cols2" : ""
            }`}
            style={
              {
                "--history-columns": grid.cols,
                gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
                gridAutoRows:
                  grid.itemHeight > 0 ? `${grid.itemHeight}px` : undefined,
                transform: `translateY(${grid.offsetY}px)`,
              } as CSSProperties
            }
          >
            {Array.from(
              { length: Math.max(0, grid.endIndex - grid.startIndex + 1) },
              (_, offset) => {
                const index = grid.startIndex + offset;
                const generation = data.get(index);
                return generation ? (
                  <div key={generation.id} className="history-cell">
                    {renderCard(generation, index)}
                  </div>
                ) : (
                  <div key={index} className="lib-skeleton" aria-hidden="true" />
                );
              },
            )}
          </div>
        ) : (
          <div
            ref={grid.windowRef}
            className={`history-vstack${compact ? " compact" : ""}`}
            style={{
              gap: grid.gap,
              transform: `translateY(${grid.offsetY}px)`,
            }}
          >
            {Array.from(
              { length: Math.max(0, grid.endRow - grid.startRow + 1) },
              (_, offset) => {
                const row = grid.startRow + offset;
                const label = sectionRowSet.has(row)
                  ? sectionLabels.get(row) ?? t("history_unknown_day")
                  : null;
                const generation = data.get(row);
                return (
                  <div key={row} className="history-vrow" style={{ gap: grid.gap }}>
                    {label && (
                      <h3
                        className="hlist-day"
                        style={{
                          height: Math.max(
                            0,
                            grid.sectionHeaderHeight - grid.gap,
                          ),
                          margin: 0,
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        {label}
                      </h3>
                    )}
                    {generation ? (
                      renderCard(generation, row)
                    ) : (
                      <div
                        className="lib-skeleton"
                        aria-hidden="true"
                        style={{ height: grid.itemHeight }}
                      />
                    )}
                  </div>
                );
              },
            )}
          </div>
        )}
      </div>

      <TimelineScrubber
        mode={phone ? "phone" : compact ? "compact" : "full"}
        total={total}
        index={grid.visibleStart}
        step={Math.max(1, grid.visibleEnd - grid.visibleStart + 1)}
        timeline={timeline}
        scrollerRef={grid.scrollerRef}
        headerRef={stickyRef}
        onSeek={(index) => grid.scrollToIndex(index, "start")}
        onLongPress={phone ? () => setJumpOpen(true) : undefined}
      />

      {selectMode && (
        <div className={`batch-bar history-batch${phone ? " phone" : ""}`}>
          <div className="batch-bar-row">
            <span className="batch-count">{t("selected_n", { n: selected.size })}</span>
            <Button
              variant="link"
              disabled={total === 0 || allResultsSelected}
              onClick={selectAllResults}
            >
              {t("select_all_results")}
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
              {series.picker(
                targetForIds([...selected]),
                () => setBatchSeriesOpen(false),
                true,
              )}
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
            void refresh();
          }}
        />
      )}
      {duplicatingGen && (
        <AddHistoryModal
          duplicate={duplicatingGen}
          onClose={() => setDuplicatingGen(null)}
          onSaved={() => {
            setDuplicatingGen(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
