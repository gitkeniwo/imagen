import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { api, type Generation, type GenerationFilters, type ImageRow, providerOf } from "../api";
import { useI18n } from "../i18n";
import { useProviders } from "../useProviders";
import AddHistoryModal from "../components/AddHistoryModal";
import { useFitColumns } from "../useFitColumns";
import SearchBox from "../components/SearchBox";
import { useToast } from "../components/Toast";
import { copyText } from "../clipboard";
import HistoryItem from "../components/HistoryItem";
import { SeriesBadge } from "../components/SeriesBits";
import { useSeriesActions } from "../components/SeriesMenu";
import { useImageSeries } from "../seriesContext";
import { downloadImage } from "../components/GenerationCard";
import Segmented from "../components/ui/Segmented";
import { PopoverSection, ViewPopover } from "../components/ui/ToolbarPopover";
import {
  type ContextMenuSection,
  type ContextMenuQuickAction,
  useContextMenu,
} from "../components/ui/ContextMenu";
import type { ViewerPager } from "../components/ImageViewer";
import PositionLine from "../components/PositionLine";
import TimelineScrubber from "../components/LibraryScrubber";
import { CHUNK, useChunkedList } from "../useChunkedList";
import { useVirtualGrid } from "../useVirtualGrid";
import { useAnchoredRefresh } from "../useAnchoredRefresh";
import { useTimeline } from "../useTimeline";
import { useRowHeightCheck } from "../useRowHeightCheck";

const FAV_COLUMNS_KEY = "imagen-fav-columns";
const FAV_ANCHOR_KEY = "imagen-favorites-anchor:";
const FAV_COLUMN_OPTIONS = [1, 2, 3];
const FAV_COLUMN_OPTIONS_FULL = [2, 3, 4];
const ENSURE_DELAY_MS = 100;

function initialFavColumns() {
  const saved = Number(localStorage.getItem(FAV_COLUMNS_KEY));
  return FAV_COLUMN_OPTIONS_FULL.includes(saved) ? saved : 2;
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

// Prompt-centric "favorites" view: the saved-prompt collection. A favorite is a
// starred generated image; this lists those generations note-first so long
// prompts are easy to tell apart, with copy / reuse / unfavorite.
export default function Favorites({
  onReuse,
  onRerun,
  onUseAsRef,
  trayIds = [],
  onRemoveFromTray,
  onOpenViewer,
  compact = false,
  refreshKey = 0,
  onChanged,
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
  onChanged?: () => void;
  phone?: boolean;
}) {
  const { t } = useI18n();
  const { isReady } = useProviders();
  const toast = useToast();
  const { open: openContextMenu } = useContextMenu();
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [columns, setColumns] = useState(initialFavColumns);
  const [editingGen, setEditingGen] = useState<Generation | null>(null);
  const [duplicatingGen, setDuplicatingGen] = useState<Generation | null>(null);
  const [outputTotal, setOutputTotal] = useState(0);
  const [timelineTick, setTimelineTick] = useState(0);
  const [jumpOpen, setJumpOpen] = useState(false);
  const notesDirty = useRef(new Set<number>());
  const stickyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fitColumns = useFitColumns(rootRef, columns);
  const layoutKey = phone ? "phone" : compact ? "compact" : "full";

  const filters = useMemo<GenerationFilters>(
    () => ({ starred: true, q: query.trim() || undefined }),
    [query],
  );
  const filtersKey = JSON.stringify(filters);
  const data = useChunkedList<Generation>({
    key: filtersKey,
    fetchChunk: async (offset, limit, signal) => {
      const result = await api.listGenerations(
        { ...filters, limit, offset },
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
          { ...filters, offset, limit },
          signal,
        )
      ).ids,
    idOf: (generation) => generation.id,
    onRows: (rows) => {
      setNotes((current) => {
        let next = current;
        for (const generation of rows) {
          const image = generation.outputImage;
          if (!image || notesDirty.current.has(image.id)) continue;
          const value = image.note ?? "";
          if (next[image.id] === value) continue;
          if (next === current) next = { ...current };
          next[image.id] = value;
        }
        return next;
      });
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
    () => api.generationTimeline(filters),
    filtersKey,
    timelineTick,
  );
  const grid = useVirtualGrid({
    count: total,
    columns: phone ? 1 : fitColumns,
    itemHeight: (width, element) =>
      Math.max(0, width - 2) * 0.75 +
      cssPx(element, "--hcard-body-h", 224) +
      cssPx(element, "--hcard-grid-gap", 12) +
      2,
    topInset: (scroller) => {
      const sticky = stickyRef.current;
      if (!sticky) return 0;
      return sticky.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    },
    topInsetTarget: stickyRef,
  });
  const { refresh, newCount, clearNew } = useAnchoredRefresh({
    data,
    grid,
    idOf: (generation) => generation.id,
    filtersKey,
    refreshKey,
    storageKey: `${FAV_ANCHOR_KEY}${layoutKey}`,
    onRefreshDone: () => setTimelineTick((n) => n + 1),
  });
  useRowHeightCheck({
    windowRef: grid.windowRef,
    expected: grid.itemHeight,
    selector: ".hcard",
    version: data.version,
  });

  useEffect(() => {
    if (!data.ready || total === 0) return;
    const timer = window.setTimeout(
      () => data.ensure(grid.startIndex, grid.endIndex),
      ENSURE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [data.ready, data.ensure, grid.endIndex, grid.startIndex, total]);

  useEffect(() => {
    localStorage.setItem(FAV_COLUMNS_KEY, String(columns));
  }, [columns]);

  useEffect(() => {
    setJumpOpen(false);
  }, [filtersKey]);

  const saveNote = async (img: ImageRow) => {
    const draft = (notes[img.id] ?? "").trim();
    if (draft === (img.note ?? "")) {
      notesDirty.current.delete(img.id);
      return;
    }
    try {
      await api.patchImage(img.id, { note: draft });
      img.note = draft;
      notesDirty.current.delete(img.id);
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const unfavorite = async (img: ImageRow) => {
    try {
      await api.patchImage(img.id, { starred: false });
      void refresh();
      onChanged?.();
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
      onChanged?.();
    } catch (e) {
      toast(t("op_failed", { msg: (e as Error).message }));
    }
  };

  const toggleTray = (img: ImageRow) => {
    if (trayIds.includes(img.id) && onRemoveFromTray) onRemoveFromTray(img);
    else onUseAsRef?.(img);
  };

  const series = useSeriesActions(() => {
    void refresh();
    onChanged?.();
  });

  const openFavoriteMenu = (
    generation: Generation,
    img: ImageRow,
    isOutput: boolean,
    trigger: HTMLElement,
    x: number,
    y: number,
    onView: () => void,
  ) => {
    const inTray = trayIds.includes(img.id);
    const quickActions: ContextMenuQuickAction[] = [
      {
        icon: "view",
        label: t("open_viewer"),
        onSelect: onView,
      },
      ...(onUseAsRef
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
    const recordActions: ContextMenuSection = [];
    const imgSeries = imageSeries(img.id) ?? [];
    const outputSeries = imgSeries.filter((e) => e.role === "output").map((e) => e.seriesId);
    const seriesRows: ContextMenuSection = isOutput
      ? series.section(
          imgSeries.map((e) => e.seriesId),
          { body: { imageIds: [img.id] }, members: outputSeries.length ? outputSeries : [null] },
        )
      : [series.openItem(imgSeries.map((e) => e.seriesId))].filter((item) => !!item) as ContextMenuSection;
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
    openContextMenu({
      x,
      y,
      trigger,
      images: [img],
      prompt: isOutput ? generation.prompt : undefined,
      sourceLabel: generation.source === "manual" ? t("imported_badge") : undefined,
      quickActions,
      seriesMarks: series.markRow(imgSeries, img.id) ?? undefined,
      sections: [recordActions, seriesRows].filter((section) => section.length > 0),
      ariaLabel: t("image_menu"),
    });
  };

  const openFavoriteViewer = (
    img: ImageRow,
    generation: Generation,
    index: number,
  ) => {
    img.generation_offset = index;
    onOpenViewer(
      img,
      [img],
      {
        offset: generation.output_index ?? 0,
        total: outputTotal,
        batchSize: CHUNK,
        fetch: async (offset, limit) => {
          const result = await api.listGenerations({
            ...filters,
            limit,
            offset,
            uniqueOutputs: true,
          });
          const outputs: ImageRow[] = [];
          for (const row of result.generations) {
            const output = row.outputImage;
            if (!output || output.deleted_at) continue;
            output.generation_offset = row.generation_offset;
            outputs.push(output);
          }
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

  // series-v2 B1a: favorites are images, so a badge can carry "+N".
  const visibleOutputIds: number[] = [];
  for (let i = grid.startIndex; i <= grid.endIndex; i++) {
    const out = data.get(i)?.outputImage;
    if (out && !out.deleted_at) visibleOutputIds.push(out.id);
  }
  const imageSeries = useImageSeries(visibleOutputIds);

  return (
    <div ref={rootRef}>
      <div className="history-toolbar" ref={stickyRef}>
        <div className="history-toolbar-row">
          <SearchBox
            value={query}
            onChange={(q) => {
              setQuery(q);
            }}
            placeholder={t("search_placeholder_history")}
          />
          {!phone && (
            <ViewPopover>
              <PopoverSection label={t("columns_per_row")}>
                <Segmented
                  dense
                  value={columns}
                  onChange={(n) => {
                    setColumns(n);
                  }}
                  options={(compact ? FAV_COLUMN_OPTIONS : FAV_COLUMN_OPTIONS_FULL).map((n) => ({
                    value: n,
                    label: String(n),
                  }))}
                />
              </PopoverSection>
            </ViewPopover>
          )}
        </div>
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
          {query ? (
            <div className="empty-state">
              <span>{t("no_results")}</span>
              <button
                onClick={() => {
                  setQuery("");
                }}
              >
                {t("clear_filters")}
              </button>
            </div>
          ) : (
            t("favorites_empty")
          )}
        </div>
      ) : null}

      <div
        className="history-vgrid favorites-vgrid virtual-list"
        ref={grid.gridRef}
        style={{ height: grid.totalHeight }}
      >
        <div
          ref={grid.windowRef}
          className={`history-list hlist grid${compact ? " compact" : ""}`}
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
              if (!generation) {
                return (
                  <div key={index} className="lib-skeleton" aria-hidden="true" />
                );
              }
              const outImg =
                generation.outputImage && !generation.outputImage.deleted_at
                  ? generation.outputImage
                  : null;
              return (
                <div key={generation.id} className="history-cell">
                  <HistoryItem
                    seriesChip={(() => {
                      const entries = outImg ? imageSeries(outImg.id) : undefined;
                      if (!outImg || !entries?.length) return undefined;
                      return (
                        <SeriesBadge
                          seriesId={entries[0].seriesId}
                          more={entries.length - 1}
                          subject={{ kind: "image", imageId: outImg.id, entries }}
                        />
                      );
                    })()}
                    g={generation}
                    layout="grid"
                    output={outImg}
                    missing={false}
                    onOpen={() =>
                      outImg &&
                      openFavoriteViewer(outImg, generation, index)
                    }
                    onToggleStar={
                      outImg ? () => unfavorite(outImg) : undefined
                    }
                    onOpenInput={(img) =>
                      onOpenViewer(img, generation.inputs ?? [])
                    }
                    tags={outImg?.tags ?? []}
                    onReuse={() => onReuse(generation)}
                    onRerun={
                      onRerun && isReady(providerOf(generation))
                        ? () => onRerun(generation)
                        : undefined
                    }
                    onUseAsRef={
                      onUseAsRef && outImg
                        ? () => onUseAsRef(outImg)
                        : undefined
                    }
                    onImageContextMenu={(img, trigger, x, y, isOutput, onView) =>
                      openFavoriteMenu(
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
                    header={
                      outImg && (
                        <input
                          className="fav-note"
                          value={notes[outImg.id] ?? outImg.note ?? ""}
                          placeholder={t("note_placeholder")}
                          aria-label={t("note_placeholder")}
                          onChange={(event) => {
                            notesDirty.current.add(outImg.id);
                            setNotes((current) => ({
                              ...current,
                              [outImg.id]: event.target.value,
                            }));
                          }}
                          onBlur={() => void saveNote(outImg)}
                        />
                      )
                    }
                  />
                </div>
              );
            },
          )}
        </div>
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
